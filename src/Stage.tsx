import React, { ReactElement } from "react";
import { StageBase, StageResponse, InitialData, Message, Character } from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";

/***
 The type that this stage persists message-level state in.
 This is primarily for readability, and not enforced.

 @description This type is saved in the database after each message,
  which makes it ideal for storing things like positions and statuses,
  but not for things like history, which is best managed ephemerally
  in the internal state of the Stage class itself.
 ***/
type MessageStateType = {
    lastResponders: string[];  // IDs of characters who responded last time
    activeCharacters: Set<string>;
};

/***
 The type of the stage-specific configuration of this stage.

 @description This is for things you want people to be able to configure,
  like background color.
 ***/
type ConfigType = {
    maxActive: number;     // Максимум активных (2-15)
    activityChance: number;  // Шанс действий (10-100)
};

/***
 The type that this stage persists chat initialization state in.
 If there is any 'constant once initialized' static state unique to a chat,
 like procedurally generated terrain that is only created ONCE and ONLY ONCE per chat,
 it belongs here.
 ***/
type InitStateType = null;     // We don't need initialization state

/***
 The type that this stage persists dynamic chat-level state in.
 This is for any state information unique to a chat,
    that applies to ALL branches and paths such as clearing fog-of-war.
 It is usually unlikely you will need this, and if it is used for message-level
    data like player health then it will enter an inconsistent state whenever
    they change branches or jump nodes. Use MessageStateType for that.
 ***/
type ChatStateType = {
    responseHistory: {
        responders: string[];
        messageContent?: string;
        timestamp: number;
    }[];
};

type ActionCategory = "explore" | "interact" | "rest" | "work";

/***
 A simple example class that implements the interfaces necessary for a Stage.
 If you want to rename it, be sure to modify App.js as well.
 @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/stage.ts
 ***/
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    private responseHistory: ChatStateType['responseHistory'] = [];
    private characters: { [key: string]: Character };
    private config: ConfigType;
    protected chat: { history: Message[] };

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        /***
         This is the first thing called in the stage,
         to create an instance of it.
         The definition of InitialData is at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/initial.ts
         Character at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/character.ts
         User at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/user.ts
         ***/
        super(data);
        
        const defaultConfig = {
            maxActive: 5,
            activityChance: 50
        };

        this.config = {
            ...defaultConfig,
            ...(data.config || {})
        };

        this.config.maxActive = Math.max(2, Math.min(15, this.config.maxActive));
        this.config.activityChance = Math.max(10, Math.min(100, this.config.activityChance));

        this.characters = data.characters;
        this.responseHistory = data.chatState?.responseHistory || [];
        this.chat = { history: [] };

        console.debug('Stage initialized with config:', this.config);
    }

    private calculateRelevanceScore(charId: string, message: Message): number {
        const char = this.characters[charId];
        const messageContent = message.content?.toLowerCase() || "";
        const charDesc = char.description?.toLowerCase() || "";
        const charPers = char.personality?.toLowerCase() || "";
        let score = 0;

        // Direct mention bonus
        if (messageContent.includes(char.name.toLowerCase())) {
            score += 5;
        }

        // Context matching
        const messageWords = new Set(messageContent.split(/\s+/));
        const descWords = new Set(charDesc.split(/\s+/));
        const persWords = new Set(charPers.split(/\s+/));
        
        descWords.forEach(word => {
            if (messageWords.has(word)) score += 0.5;
        });
        
        persWords.forEach(word => {
            if (messageWords.has(word)) score += 0.5;
        });

        // Recent participation adjustment
        const recentResponses = this.responseHistory.slice(-3);
        const participationCount = recentResponses.filter(h => 
            h.responders.includes(charId)
        ).length;
        score -= participationCount * 0.5;

        // Add randomness to prevent repetitive patterns
        score += Math.random() * 2;

        return score;
    }

    private selectSceneParticipants(message: Message): string[] {
        const availableChars = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (availableChars.length === 0) return [];

        // Score all characters based on relevance to the message
        const scores = availableChars.map(id => ({
            id,
            score: this.calculateRelevanceScore(id, message)
        }));

        // Sort by score and select main responder
        scores.sort((a, b) => b.score - a.score);
        const participants = [scores[0].id];

        // Select additional participants based on relevance and probability
        let remainingChars = scores.slice(1);
        let currentProb = this.config.activityChance / 100;

        while (
            participants.length < this.config.maxActive &&
            remainingChars.length > 0 &&
            Math.random() < currentProb
        ) {
            // Weight selection by score
            const totalScore = remainingChars.reduce((sum, char) => sum + char.score, 0);
            let random = Math.random() * totalScore;
            let selectedIndex = 0;

            for (let i = 0; i < remainingChars.length; i++) {
                random -= remainingChars[i].score;
                if (random <= 0) {
                    selectedIndex = i;
                    break;
                }
            }

            participants.push(remainingChars[selectedIndex].id);
            remainingChars.splice(selectedIndex, 1);
            currentProb *= 0.7; // Decrease probability for each additional participant
        }

        console.debug('Selected participants:', participants.map(id => this.characters[id].name));
        return participants;
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        /***
         This is called immediately after the constructor, in case there is some asynchronous code you need to
         run on instantiation.
         ***/
        const activeCount = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved).length;
        if (activeCount < 2) {
            return {
                success: false,
                error: "Need at least 2 characters for a living world.",
                initState: null,
                chatState: null
            };
        }
        return {
            /*** @type boolean @default null
             @description The 'success' boolean returned should be false IFF (if and only if), some condition is met that means
              the stage shouldn't be run at all and the iFrame can be closed/removed.
              For example, if a stage displays expressions and no characters have an expression pack,
              there is no reason to run the stage, so it would return false here. ***/
            success: true,
            /*** @type null | string @description an error message to show
             briefly at the top of the screen, if any. ***/
            error: null,
            initState: null,
            chatState: { responseHistory: this.responseHistory }
        };
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const participants = this.selectSceneParticipants(userMessage);
        if (participants.length === 0) {
            return {
                stageDirections: "System: No characters available for interaction.",
                messageState: { lastResponders: [], activeCharacters: new Set() },
                chatState: { responseHistory: this.responseHistory }
            };
        }

        const recentHistory = this.responseHistory.slice(-3).map(entry => 
            `${entry.responders.map(id => this.characters[id].name).join(" and ")} ${entry.messageContent ? `said "${entry.messageContent}"` : 'interacted'}`
        ).join("\n");

        const characterInfo = participants.map(id => {
            const char = this.characters[id];
            return `${char.name}: ${char.personality || ""}`;
        }).join("\n");

        const stageDirections = `System: Group conversation with ${participants.length} characters.

Characters:
${characterInfo}

Format: Each character's response should be in the format:
**{{Name}}** *action/emotion* "Dialogue"

Rules:
1. ${this.characters[participants[0]].name} leads as most relevant
2. Others join naturally based on context
3. Keep interactions natural and in-character
4. Maintain conversation flow`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: participants,
                activeCharacters: new Set(participants)
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { 
                        responders: participants,
                        messageContent: userMessage.content,
                        timestamp: Date.now()
                    }
                ]
            }
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        if (this.responseHistory.length > 0) {
            const lastEntry = this.responseHistory[this.responseHistory.length - 1];
            lastEntry.messageContent = botMessage.content;

            // Extract all participating characters
            const charPattern = /\*\*{{([^}]+)}}\*\*/g;
            const participants = new Set<string>();
            let match;
            
            while ((match = charPattern.exec(botMessage.content)) !== null) {
                const charName = match[1];
                const charId = Object.keys(this.characters)
                    .find(id => this.characters[id].name === charName);
                if (charId) {
                    participants.add(charId);
                }
            }

            // Update responders with actual participants
            lastEntry.responders = Array.from(participants);

            // Create a summary of who participated
            const participantNames = Array.from(participants)
                .map(id => this.characters[id].name)
                .join(", ");

            return {
                modifiedMessage: botMessage.content,
                systemMessage: `System: ${participantNames} participated in this interaction.`,
                error: null,
                chatState: {
                    responseHistory: this.responseHistory
                }
            };
        }

        return {
            modifiedMessage: botMessage.content,
            error: null,
            systemMessage: null,
            chatState: {
                responseHistory: this.responseHistory
            }
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        if (state?.lastResponders) {
            this.responseHistory.push({ 
                responders: state.lastResponders,
                timestamp: Date.now()
            });
        }
    }

    render(): ReactElement {
        return <></>;
    }
}

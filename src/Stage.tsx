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
    activeCharacters: Set<string>;  // Characters currently active in the conversation
};

/***
 The type of the stage-specific configuration of this stage.

 @description This is for things you want people to be able to configure,
  like background color.
 ***/
type ConfigType = {
    maxResponders: number;     // Maximum number of characters that can respond (2-15)
    chainProbability: number;  // Probability of chain responses (10-100)
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
        responders: string[];  // Character IDs who responded
        messageContent?: string; // Content of the message
        timestamp: number;     // When the message was sent
    }[];
};

/***
 A simple example class that implements the interfaces necessary for a Stage.
 If you want to rename it, be sure to modify App.js as well.
 @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/stage.ts
 ***/
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    private responseHistory: ChatStateType['responseHistory'] = [];
    private characters: { [key: string]: Character };
    private config: ConfigType;

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        /***
         This is the first thing called in the stage,
         to create an instance of it.
         The definition of InitialData is at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/initial.ts
         Character at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/character.ts
         User at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/user.ts
         ***/
        super(data);
        const { characters, config: rawConfig, chatState } = data;
        
        this.characters = characters;
        this.config = {
            maxResponders: 5,
            chainProbability: 50,
            ...(rawConfig || {})
        };

        // Validate config
        if (!this.config.maxResponders || this.config.maxResponders < 2 || this.config.maxResponders > 15) {
            this.config.maxResponders = 5;
        }
        if (!this.config.chainProbability || this.config.chainProbability < 10 || this.config.chainProbability > 100) {
            this.config.chainProbability = 50;
        }

        // Initialize response history
        this.responseHistory = chatState?.responseHistory || [];
    }

    private selectMainResponder(message: Message): string {
        const availableChars = Object.keys(this.characters).filter(id => 
            !this.characters[id].isRemoved
        );
        if (availableChars.length === 0) return '';

        // Direct mention check
        const mentionedChar = availableChars.find(id => {
            const char = this.characters[id];
            return message.content?.toLowerCase().includes(char.name.toLowerCase());
        });
        if (mentionedChar) return mentionedChar;

        // Score based on context and history
        const scores = new Map<string, number>();
        const recentHistory = this.responseHistory.slice(-3);

        availableChars.forEach(id => {
            const char = this.characters[id];
            let score = 0;

            // Context matching
            if (message.content && char.description) {
                const messageWords = message.content.toLowerCase().split(' ');
                const descriptionWords = char.description.toLowerCase().split(' ');
                score += this.calculateKeywordOverlap(messageWords, descriptionWords);
            }

            // Recent participation penalty
            const recentParticipation = recentHistory.filter(h => h.responders.includes(id)).length;
            score -= recentParticipation;

            // Add some randomness
            score += Math.random();

            scores.set(id, score);
        });

        // Return highest scoring character
        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])[0][0];
    }

    private selectAdditionalResponders(mainResponderId: string): string[] {
        const responders = [mainResponderId];
        const availableChars = Object.keys(this.characters).filter(id => 
            !this.characters[id].isRemoved && 
            id !== mainResponderId
        );

        let currentProbability = this.config.chainProbability;
        while (
            responders.length < this.config.maxResponders && 
            availableChars.length > 0 && 
            Math.random() * 100 < currentProbability
        ) {
            const index = Math.floor(Math.random() * availableChars.length);
            const selectedChar = availableChars[index];
            responders.push(selectedChar);
            availableChars.splice(index, 1);
            currentProbability *= 0.7;
        }

        return responders;
    }

    private calculateKeywordOverlap(keywords1: string[], keywords2: string[]): number {
        const set1 = new Set(keywords1);
        return keywords2.filter(word => set1.has(word)).length;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const mainResponder = this.selectMainResponder(userMessage);
        const allResponders = this.selectAdditionalResponders(mainResponder);
        
        // Get recent history for context
        const recentHistory = this.responseHistory.slice(-3);
        const contextInfo = recentHistory.length > 0 
            ? recentHistory.map(entry => 
                `Previous interaction: ${entry.responders.map(id => this.characters[id].name).join(" and ")} ${entry.messageContent ? `said "${entry.messageContent}"` : ''}`
            ).join("\n")
            : "";

        // Format character information
        const characterInfo = Object.keys(this.characters)
            .filter(id => !this.characters[id].isRemoved)
            .map(id => {
                const char = this.characters[id];
                return `${char.name}:
${char.personality || char.description}
${char.scenario ? `Current scenario: ${char.scenario}` : ''}`;
            }).join("\n\n");

        const stageDirections = `System: This is a dynamic group conversation. Characters interact naturally based on context and their personalities.

Recent Context:
${contextInfo}

Available Characters:
${characterInfo}

Response Format:
{{char=Name}} *actions* Says something

Rules:
- Up to ${this.config.maxResponders} characters can participate in each response
- Each additional character has ${this.config.chainProbability}% chance to join
- Characters maintain their personalities and scenarios
- Responses should build on previous context

Continue the conversation:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: allResponders,
                activeCharacters: new Set(Object.keys(this.characters).filter(id => !this.characters[id].isRemoved))
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { 
                        responders: allResponders,
                        messageContent: userMessage.content,
                        timestamp: Date.now()
                    }
                ]
            }
        };
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        /***
         This is called immediately after the constructor, in case there is some asynchronous code you need to
         run on instantiation.
         ***/
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

    async setState(state: MessageStateType): Promise<void> {
        if (state?.lastResponders) {
            this.responseHistory.push({ 
                responders: state.lastResponders,
                timestamp: Date.now(),
                messageContent: ''
            });
        }
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        if (this.responseHistory.length > 0) {
            const lastEntry = this.responseHistory[this.responseHistory.length - 1];
            lastEntry.messageContent = botMessage.content;

            // Extract all participating characters
            const charPattern = /{{char=([^}]+)}}/g;
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

    render(): ReactElement {
        return <></>;
    }
}

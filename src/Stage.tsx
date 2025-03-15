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
    temporarilyExcluded: Set<string>;  // Characters temporarily out of conversation
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
        eventContext?: string; // Context of the current event/topic
        mood?: { [characterId: string]: string }; // Character moods/states
    }[];
    firstMessage?: boolean;  // Flag for first message handling
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
    private isFirstMessage: boolean = false;

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

        // Preserve existing history if available
        if (chatState?.responseHistory) {
            this.responseHistory = chatState.responseHistory;
            this.isFirstMessage = false;
        } else {
            this.responseHistory = [];
            this.isFirstMessage = true;
        }
    }

    private selectResponders(message: Message): string[] {
        const availableChars = Object.keys(this.characters).filter(id => 
            !this.characters[id].isRemoved && 
            !this.getTemporarilyExcluded().has(id)
        );
        if (availableChars.length === 0) return [];

        // Check for direct mentions
        const mentionedChars = availableChars.filter(id => {
            const char = this.characters[id];
            return message.content?.toLowerCase().includes(char.name.toLowerCase());
        });

        if (mentionedChars.length > 0) {
            // Add related characters based on scenario
            const relatedChars = availableChars.filter(id => {
                if (mentionedChars.includes(id)) return false;
                const char = this.characters[id];
                return mentionedChars.some(mentionedId => 
                    this.characters[mentionedId].scenario?.toLowerCase().includes(char.name.toLowerCase()) ||
                    char.scenario?.toLowerCase().includes(this.characters[mentionedId].name.toLowerCase())
                );
            });
            
            const allRelevantChars = [...mentionedChars, ...relatedChars];
            return allRelevantChars.slice(0, this.config.maxResponders);
        }

        // Select random initial responder
        const mainResponder = availableChars[Math.floor(Math.random() * availableChars.length)];
        const responders = [mainResponder];
        
        // Filter out main responder from available chars
        const remainingChars = availableChars.filter(id => id !== mainResponder);
        
        // Add additional responders based on chain probability
        let currentProbability = this.config.chainProbability;
        while (
            responders.length < this.config.maxResponders && 
            remainingChars.length > 0 && 
            Math.random() * 100 < currentProbability
        ) {
            const index = Math.floor(Math.random() * remainingChars.length);
            responders.push(remainingChars[index]);
            remainingChars.splice(index, 1);
            currentProbability *= 0.7;
        }

        return responders;
    }

    private getTemporarilyExcluded(): Set<string> {
        const lastState = this.responseHistory[this.responseHistory.length - 1];
        if (lastState?.mood) {
            return new Set(
                Object.entries(lastState.mood)
                    .filter(([_, mood]) => 
                        mood.includes('left') || 
                        mood.includes('away') || 
                        mood.includes('excluded'))
                    .map(([id, _]) => id)
            );
        }
        return new Set();
    }

    private getCharacterMood(characterId: string): string | undefined {
        const lastState = this.responseHistory[this.responseHistory.length - 1];
        return lastState?.mood?.[characterId];
    }

    private getCurrentEventContext(message: Message): string {
        const recentMessages = this.responseHistory.slice(-3);
        const keywords = new Set<string>();
        
        // Extract keywords from recent messages
        recentMessages.forEach(history => {
            if (history.messageContent) {
                const words = history.messageContent.toLowerCase()
                    .split(' ')
                    .filter(word => word.length > 3);  // Filter out small words
                words.forEach(word => keywords.add(word));
            }
        });

        // Add current message keywords
        if (message.content) {
            const currentWords = message.content.toLowerCase()
                .split(' ')
                .filter(word => word.length > 3);
            currentWords.forEach(word => keywords.add(word));
        }

        return Array.from(keywords).join(' ');
    }

    private selectAdditionalResponders(mainResponders: string[], message: Message): string[] {
        const allResponders = [...mainResponders];
        const availableChars = Object.keys(this.characters).filter(id => 
            !this.characters[id].isRemoved && 
            !this.getTemporarilyExcluded().has(id) && 
            !mainResponders.includes(id)
        );

        if (availableChars.length === 0) return allResponders;

        let currentProbability = this.config.chainProbability;
        const maxAdditional = Math.min(
            this.config.maxResponders - mainResponders.length,
            Math.ceil(availableChars.length * 0.6)
        );

        while (
            allResponders.length < this.config.maxResponders && 
            availableChars.length > 0 && 
            allResponders.length < maxAdditional &&
            Math.random() * 100 < currentProbability
        ) {
            const randomIndex = Math.floor(Math.random() * availableChars.length);
            const selectedChar = availableChars[randomIndex];
            
            allResponders.push(selectedChar);
            availableChars.splice(randomIndex, 1);
            
            currentProbability *= 0.8;
        }

        return allResponders;
    }

    private analyzeRecentInteractions(): Map<string, number> {
        const interactions = new Map<string, number>();
        const recentHistory = this.responseHistory.slice(-10);

        recentHistory.forEach((history, index) => {
            const weight = (index + 1) / recentHistory.length; // More recent interactions have higher weight
            history.responders.forEach(id1 => {
                history.responders.forEach(id2 => {
                    if (id1 !== id2) {
                        const key = `${id1}-${id2}`;
                        interactions.set(key, (interactions.get(key) || 0) + weight);
                    }
                });
            });
        });

        return interactions;
    }

    private getLastActiveTimestamp(characterId: string): number | null {
        for (let i = this.responseHistory.length - 1; i >= 0; i--) {
            if (this.responseHistory[i].responders.includes(characterId)) {
                return this.responseHistory[i].timestamp;
            }
        }
        return null;
    }

    private calculateKeywordOverlap(keywords1: string[], keywords2: string[]): number {
        const set1 = new Set(keywords1);
        return keywords2.filter(word => set1.has(word)).length;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const responders = this.selectResponders(userMessage);
        
        // Format character information
        const characterInfo = responders.map(id => {
            const char = this.characters[id];
            return `${char.name}:
${char.system_prompt ? `System prompt: ${char.system_prompt}` : ''}
Personality: ${char.personality || 'Based on description'}
Description: ${char.description}
${char.example_dialogs ? `Example dialogs: ${char.example_dialogs}` : ''}
${char.scenario ? `Current scenario: ${char.scenario}` : ''}`;
        }).join("\n\n");

        // Get recent history for context
        const recentHistory = this.responseHistory.slice(-3);
        const contextInfo = recentHistory.length > 0 
            ? recentHistory.map(entry => 
                `Previous interaction: ${entry.responders.map(id => this.characters[id].name).join(" and ")} ${entry.messageContent ? `said "${entry.messageContent}"` : ''}`
            ).join("\n")
            : "";

        const stageDirections = `System: This is a dynamic group conversation. Characters should interact naturally and respond to each other.

${contextInfo}

Active characters:
${characterInfo}

Response format:
{{char}} *expresses emotions or actions* Says something while interacting naturally with others

Guidelines:
1. Characters should maintain their personalities and respond according to their backgrounds
2. Natural conversation flow with characters responding to each other
3. Use *asterisks* for actions and emotions
4. Keep the conversation engaging and dynamic

Continue conversation:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: responders,
                activeCharacters: new Set(responders),
                temporarilyExcluded: this.getTemporarilyExcluded()
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { 
                        responders,
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
                eventContext: '',  // Empty context for state changes
                messageContent: ''
            });
        }
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        if (this.responseHistory.length > 0) {
            const lastEntry = this.responseHistory[this.responseHistory.length - 1];
            lastEntry.messageContent = botMessage.content;

            // Extract moods from response
            const moodPattern = /{{char(?:=(\w+))?}}\s*\*(.*?)\*/g;
            const moods: { [key: string]: string } = {};
            let match;

            while ((match = moodPattern.exec(botMessage.content)) !== null) {
                const charName = match[1];
                const mood = match[2];
                if (charName && mood) {
                    const charId = Object.keys(this.characters)
                        .find(id => this.characters[id].name === charName);
                    if (charId) {
                        moods[charId] = mood;
                    }
                }
            }

            lastEntry.mood = moods;
        }

        // Clean up character tags in the response
        let modifiedMessage = botMessage.content;
        if (!modifiedMessage.includes('{{char}}')) {
            const lastResponders = this.responseHistory[this.responseHistory.length - 1]?.responders || [];
            modifiedMessage = lastResponders.map(id => {
                const char = this.characters[id];
                const charName = char.name;
                return modifiedMessage.replace(new RegExp(`{{char=${charName}}}`, 'g'), '{{char}}');
            }).join('\n\n');
        }

        return {
            modifiedMessage,
            error: null,
            systemMessage: null,
            chatState: {
                responseHistory: this.responseHistory,
                firstMessage: false
            }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

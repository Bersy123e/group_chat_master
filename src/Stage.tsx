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
        eventContext?: string; // Context of the current event/topic
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

        // Initialize response history from chatState if available
        if (chatState?.responseHistory) {
            this.responseHistory = chatState.responseHistory;
        }
    }

    private selectMainResponder(message: Message): string {
        const charIds = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (charIds.length === 0) return '';

        const relevanceScores = new Map<string, number>();
        const currentEvent = this.getCurrentEventContext(message);
        const recentHistory = this.responseHistory.slice(-5);

        charIds.forEach(id => {
            const char = this.characters[id];
            let score = 0;

            // Event context relevance
            if (currentEvent && char.description) {
                const eventKeywords = currentEvent.toLowerCase().split(' ');
                const descriptionKeywords = char.description.toLowerCase().split(' ');
                score += this.calculateKeywordOverlap(eventKeywords, descriptionKeywords) * 2;
            }

            // Recent participation analysis
            const characterParticipation = recentHistory.filter(h => h.responders.includes(id)).length;
            if (characterParticipation > 0) {
                // Character is active in conversation
                score += 1;
            } else {
                // Penalty for inactive characters
                score -= 2;
            }

            // Message content relevance
            if (char.description && message.content) {
                const descriptionKeywords = char.description.toLowerCase().split(' ');
                const messageKeywords = message.content.toLowerCase().split(' ');
                score += this.calculateKeywordOverlap(descriptionKeywords, messageKeywords);
            }

            relevanceScores.set(id, score);
        });

        // Select character with highest relevance score
        return Array.from(relevanceScores.entries())
            .sort((a, b) => b[1] - a[1])[0][0];
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

    private selectAdditionalResponders(mainResponderId: string, message: Message): string[] {
        const responders = [mainResponderId];
        const availableChars = new Set(
            Object.keys(this.characters).filter(id => 
                !this.characters[id].isRemoved && id !== mainResponderId
            )
        );

        // Get recent interaction patterns
        const recentInteractions = this.analyzeRecentInteractions();
        const currentEvent = this.getCurrentEventContext(message);

        // Calculate maximum responders based on context
        const dynamicMaxResponders = Math.min(
            this.config.maxResponders,
            Math.max(2, Math.ceil(availableChars.size * 0.6))
        );

        let currentProbability = this.config.chainProbability;
        while (
            responders.length < dynamicMaxResponders && 
            availableChars.size > 0 && 
            Math.random() * 100 < currentProbability
        ) {
            const scores = new Map<string, number>();
            availableChars.forEach(id => {
                let score = 0;
                
                // Event context relevance
                if (currentEvent && this.characters[id].description) {
                    const eventKeywords = currentEvent.toLowerCase().split(' ');
                    const descriptionKeywords = this.characters[id].description.toLowerCase().split(' ');
                    score += this.calculateKeywordOverlap(eventKeywords, descriptionKeywords) * 1.5;
                }

                // Interaction patterns
                responders.forEach(responderId => {
                    const interactionStrength = recentInteractions.get(`${id}-${responderId}`) || 0;
                    score += interactionStrength * 2;
                });

                // Activity decay
                const lastActive = this.getLastActiveTimestamp(id);
                if (lastActive) {
                    const timeDiff = Date.now() - lastActive;
                    score -= Math.min(3, timeDiff / (1000 * 60)); // Decay over minutes
                }

                scores.set(id, score);
            });

            // Select character with highest score
            let selectedChar = Array.from(scores.entries())
                .sort((a, b) => b[1] - a[1])[0][0];

            responders.push(selectedChar);
            availableChars.delete(selectedChar);
            currentProbability *= 0.6; // Steeper probability reduction
        }

        return responders;
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
        const mainResponder = this.selectMainResponder(userMessage);
        const allResponders = this.selectAdditionalResponders(mainResponder, userMessage);
        const currentEvent = this.getCurrentEventContext(userMessage);
        
        // Get recent history for context
        const recentHistory = this.responseHistory.slice(-3);
        const contextInfo = recentHistory.length > 0 
            ? recentHistory.map(entry => 
                `Previous interaction: ${entry.responders.map(id => this.characters[id].name).join(" and ")} ${entry.eventContext ? `discussed ${entry.eventContext}` : `said "${entry.messageContent}"`}`
              ).join("\n")
            : "";

        // Format character information
        const characterInfo = allResponders.map(id => {
            const char = this.characters[id];
            return `${char.name}:
Personality: ${char.personality || 'Based on description'}
Description: ${char.description}
${char.example_dialogs ? `Example dialogs: ${char.example_dialogs}` : ''}`;
        }).join("\n\n");

        const stageDirections = `System: This is an ongoing group conversation. Characters will interact naturally based on the current context and their relationships.

Current context: ${currentEvent}
${contextInfo}

Active characters:
${characterInfo}

Response format:
{{char}} *character speaks and interacts naturally with others*

Requirements:
1. Characters should interact based on the current context and their relationships
2. Create natural dialogue flow with reactions to others' statements
3. Stay true to each character's personality
4. Reference relevant past interactions when appropriate
5. Focus on the ongoing conversation rather than just responding to the user
6. Characters can express emotions, actions, and reactions using *asterisks*

Begin group interaction:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: allResponders,
                activeCharacters: new Set(allResponders)
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { 
                        responders: allResponders,
                        messageContent: userMessage.content,
                        timestamp: Date.now(),
                        eventContext: currentEvent
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
        // Update the last response history entry with the bot's message content
        if (this.responseHistory.length > 0) {
            const lastEntry = this.responseHistory[this.responseHistory.length - 1];
            lastEntry.messageContent = botMessage.content;
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
            chatState: null
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

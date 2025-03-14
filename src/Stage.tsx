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

        // Initialize response history and handle first message
        if (chatState?.responseHistory) {
            this.responseHistory = chatState.responseHistory;
        } else {
            this.responseHistory = [];
            this.isFirstMessage = true;
        }
    }

    private selectMainResponder(message: Message): string[] {
        const charIds = Object.keys(this.characters).filter(id => 
            !this.characters[id].isRemoved && 
            !this.getTemporarilyExcluded().has(id)
        );
        if (charIds.length === 0) return [];

        const relevanceScores = new Map<string, number>();
        const currentEvent = this.getCurrentEventContext(message);
        const recentHistory = this.responseHistory.slice(-5);

        // Direct mention check
        const mentionedChars = charIds.filter(id => {
            const char = this.characters[id];
            return message.content?.toLowerCase().includes(char.name.toLowerCase());
        });

        if (mentionedChars.length > 0) {
            return mentionedChars;
        }

        charIds.forEach(id => {
            const char = this.characters[id];
            let score = 0;

            // Context relevance
            if (currentEvent && char.description) {
                const eventKeywords = currentEvent.toLowerCase().split(' ');
                const descriptionKeywords = char.description.toLowerCase().split(' ');
                score += this.calculateKeywordOverlap(eventKeywords, descriptionKeywords) * 2;
            }

            // Message content relevance
            if (char.personality && message.content) {
                const personalityKeywords = char.personality.toLowerCase().split(' ');
                const messageKeywords = message.content.toLowerCase().split(' ');
                score += this.calculateKeywordOverlap(personalityKeywords, messageKeywords) * 1.5;
            }

            // Recent participation balance
            const recentParticipation = recentHistory.filter(h => h.responders.includes(id)).length;
            score -= recentParticipation * 0.5;

            // Add some randomness for variety
            score += Math.random();

            relevanceScores.set(id, score);
        });

        // Select top scoring characters
        const sortedChars = Array.from(relevanceScores.entries())
            .sort((a, b) => b[1] - a[1]);
        
        // Return at least one character, more if scores are close
        const topScore = sortedChars[0][1];
        return sortedChars
            .filter(([_, score]) => score > topScore * 0.7)
            .slice(0, Math.min(3, Math.ceil(charIds.length / 2)))
            .map(([id, _]) => id);
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
        const isFirstMessage = this.isFirstMessage;
        this.isFirstMessage = false;
        
        // Handle first message
        if (isFirstMessage) {
            const activeChars = Object.entries(this.characters)
                .filter(([_, char]) => !char.isRemoved && char.first_message)
                .map(([id, _]) => id);

            return {
                stageDirections: `System: This is the start of the conversation. Characters will introduce themselves naturally.

Active characters:
${activeChars.map(id => {
    const char = this.characters[id];
    return `${char.name}:
First message: ${char.first_message}
Personality: ${char.personality || 'Based on description'}
Description: ${char.description}`;
}).join('\n\n')}

Response format:
{{char}} *expresses emotions or actions* Says something while interacting naturally

Begin scene with character introductions:`,
                messageState: {
                    lastResponders: activeChars,
                    activeCharacters: new Set(activeChars),
                    temporarilyExcluded: new Set()
                },
                chatState: {
                    responseHistory: [{
                        responders: activeChars,
                        timestamp: Date.now(),
                        eventContext: 'Initial introductions',
                        messageContent: ''
                    }],
                    firstMessage: true
                }
            };
        }

        const mainResponders = this.selectMainResponder(userMessage);
        const allResponders = this.selectAdditionalResponders(mainResponders, userMessage);
        const currentEvent = this.getCurrentEventContext(userMessage);
        
        // Get recent history for context
        const recentHistory = this.responseHistory.slice(-3);
        const contextInfo = recentHistory.length > 0 
            ? recentHistory.map(entry => 
                `Previous interaction: ${entry.responders.map(id => this.characters[id].name).join(" and ")} ${entry.messageContent ? `said "${entry.messageContent}"` : ''}`
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

        const stageDirections = `System: This is a dynamic group conversation where characters interact naturally with each other.

Current context: ${currentEvent}
${contextInfo}

Active characters:
${characterInfo}

Response format:
{{char}} *expresses emotions or actions* Says something while interacting naturally with others

Guidelines:
1. Characters should respond to each other in a natural conversation flow
2. Use *asterisks* for actions and emotional expressions
3. Keep responses in character and maintain conversation flow
4. Characters can interact with each other in the same message

Continue conversation:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: allResponders,
                activeCharacters: new Set(allResponders),
                temporarilyExcluded: this.getTemporarilyExcluded()
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

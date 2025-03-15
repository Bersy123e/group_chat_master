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
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, undefined> {
    private responseHistory: ChatStateType['responseHistory'] = [];
    private characters: { [key: string]: Character };

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, undefined>) {
        /***
         This is the first thing called in the stage,
         to create an instance of it.
         The definition of InitialData is at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/initial.ts
         Character at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/character.ts
         User at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/user.ts
         ***/
        super(data);
        const { characters, chatState } = data;
        
        this.characters = characters;
        this.responseHistory = chatState?.responseHistory || [];
    }

    private getAvailableCharacters(): string[] {
        return Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
    }

    private buildCharacterPrompt(
        charId: string,
        userMessage: Message,
        recentHistory: string,
        otherResponses: string[]
    ): string {
        const char = this.characters[charId];
        let prompt = `You are ${char.name}.\n`;
        
        if (char.personality) {
            prompt += `Your personality: ${char.personality}\n`;
        }
        if (char.description) {
            prompt += `Your description: ${char.description}\n`;
        }
        if (char.scenario) {
            prompt += `Current scenario: ${char.scenario}\n`;
        }

        if (recentHistory) {
            prompt += `\nRecent chat history:\n${recentHistory}\n`;
        }

        prompt += `\nUser's message: ${userMessage.content}\n`;

        if (otherResponses.length > 0) {
            prompt += `\nOther characters have already responded:\n${otherResponses.join("\n")}\n`;
        }

        prompt += `\nRespond naturally in character, considering the context and other characters' responses.`;
        return prompt;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const availableChars = this.getAvailableCharacters();
        
        // Get recent history for context
        const recentHistory = this.responseHistory.slice(-3)
            .map(entry => 
                `${entry.responders.map(id => this.characters[id].name).join(" and ")}: ${entry.messageContent || ''}`
            ).join("\n");

        // Format character information and their potential responses
        const characterInfo = availableChars
            .map(id => {
                const char = this.characters[id];
                return `${char.name}:
${char.personality || char.description}
${char.scenario ? `Current scenario: ${char.scenario}` : ''}`;
            }).join("\n\n");

        // Determine who should respond first (mentioned characters get priority)
        const mentionedChars = availableChars.filter(id => 
            userMessage.content?.toLowerCase().includes(this.characters[id].name.toLowerCase())
        );

        const respondingChars = mentionedChars.length > 0 ? mentionedChars : availableChars;

        const stageDirections = `System: Group conversation where characters interact naturally based on context and relationships.

Recent History:
${recentHistory}

Available Characters:
${characterInfo}

Rules:
1. Response Order:
   - Characters mentioned by name should respond first
   - Other characters may join based on their personality and the context
   - Each character should react naturally to both the user and other characters

2. Group Dynamics:
   - Stay true to each character's personality and background
   - Consider relationships and previous interactions
   - React to both the user's message and other characters' responses

Format:
**{{char}}** *action/emotion* Speaks and interacts with others
[Each character response starts with **{{their name}}**]

Responding characters: ${respondingChars.map(id => this.characters[id].name).join(", ")}

Write a group response following the rules above:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: respondingChars,
                activeCharacters: new Set(availableChars)
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { 
                        responders: respondingChars,
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

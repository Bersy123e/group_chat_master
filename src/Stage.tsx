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
        const { characters, config: rawConfig } = data;
        
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
    }

    private selectMainResponder(message: Message, history: any[]): string {
        const charIds = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (charIds.length === 0) return '';

        // Analyze message and history to find most relevant character
        // For now, just select randomly
        return charIds[Math.floor(Math.random() * charIds.length)];
    }

    private selectAdditionalResponders(mainResponderId: string): string[] {
        const responders = [mainResponderId];
        const availableChars = new Set(
            Object.keys(this.characters).filter(id => 
                !this.characters[id].isRemoved && id !== mainResponderId
            )
        );

        let currentProbability = this.config.chainProbability;
        while (
            responders.length < this.config.maxResponders && 
            availableChars.size > 0 && 
            Math.random() * 100 < currentProbability
        ) {
            const nextResponder = Array.from(availableChars)[Math.floor(Math.random() * availableChars.size)];
            responders.push(nextResponder);
            availableChars.delete(nextResponder);
            currentProbability *= 0.7; // Decrease probability for each additional responder
        }

        return responders;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const mainResponder = this.selectMainResponder(userMessage, []);
        const allResponders = this.selectAdditionalResponders(mainResponder);
        
        const respondersInfo = allResponders.map(id => {
            const char = this.characters[id];
            return `${char.name} (${char.description})`;
        });

        // Create dynamic conversation instructions
        const stageDirections = `The following characters will participate in this conversation, responding in order and interacting naturally with each other:

${respondersInfo.map((info, i) => `${i + 1}. ${info}`).join('\n')}

Instructions:
1. ${this.characters[mainResponder].name} MUST respond first
2. Each character should acknowledge and react to previous responses
3. Maintain each character's unique personality and perspective
4. Keep the conversation natural and flowing
5. Each character should contribute meaningfully to the discussion`;

        return {
            stageDirections,
            messageState: { lastResponders: allResponders },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { responders: allResponders }
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
        /***
         This can be called at any time, typically after a jump to a different place in the chat tree
         or a swipe. Note how neither InitState nor ChatState are given here. They are not for
         state that is affected by swiping.
         ***/
        if (state?.lastResponders) {
            this.responseHistory.push({ responders: state.lastResponders });
        }
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        return {
            stageDirections: null,
            messageState: null,
            modifiedMessage: null,
            error: null,
            systemMessage: null,
            chatState: null
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

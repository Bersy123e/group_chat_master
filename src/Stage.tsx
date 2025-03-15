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
    characterStatus: { [key: string]: { state: "active" | "away" | "busy" } };
};

type ActionCategory = "explore" | "interact" | "rest" | "work";

/***
 A simple example class that implements the interfaces necessary for a Stage.
 If you want to rename it, be sure to modify App.js as well.
 @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/stage.ts
 ***/
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    private responseHistory: ChatStateType['responseHistory'] = [];
    private characterStatus: ChatStateType['characterStatus'] = {};
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
        
        this.config = {
            maxActive: data.config?.maxActive || 5,
            activityChance: data.config?.activityChance || 50
        };

        this.characters = data.characters;
        this.responseHistory = data.chatState?.responseHistory || [];
        this.characterStatus = data.chatState?.characterStatus || {};
        this.chat = { history: [] };

        Object.keys(this.characters).forEach(id => {
            if (!this.characterStatus[id]) {
                this.characterStatus[id] = { state: "active" };
            }
        });
    }

    async setState(state: MessageStateType): Promise<void> {
        // No state updates needed
    }

    private selectSceneParticipants(message: Message): string[] {
        const availableChars = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (availableChars.length < 2) return [];

        // Главный участник
        let mainResponder = availableChars.find(id => 
            message.content?.toLowerCase().includes(this.characters[id].name.toLowerCase()) && 
            this.characterStatus[id].state === "active"
        );
        if (!mainResponder) {
            const activeChars = availableChars.filter(id => this.characterStatus[id].state === "active");
            const scores = activeChars.map(id => {
                const desc = this.characters[id].description?.toLowerCase() || "";
                const pers = this.characters[id].personality?.toLowerCase() || "";
                let score = (desc.includes("talkative") || pers.includes("outgoing")) ? 1 : 0;
                if (desc.includes("shy") || pers.includes("quiet")) score -= 0.5;
                score += Math.random();
                return [id, score] as [string, number];
            });
            mainResponder = scores.sort((a, b) => b[1] - a[1])[0]?.[0] || availableChars[0];
        }

        const participants = [mainResponder];
        const remainingChars = availableChars.filter(id => id !== mainResponder);
        
        let currentProb = this.config.activityChance / 100;

        while (
            participants.length < this.config.maxActive &&
            remainingChars.length > 0 &&
            Math.random() < currentProb
        ) {
            const nextChar = remainingChars[Math.floor(Math.random() * remainingChars.length)];
            participants.push(nextChar);
            remainingChars.splice(remainingChars.indexOf(nextChar), 1);
            currentProb *= this.config.activityChance / 100;
        }

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
            chatState: { responseHistory: this.responseHistory, characterStatus: this.characterStatus }
        };
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const participants = this.selectSceneParticipants(userMessage);
        if (participants.length === 0) {
            return {
                stageDirections: "System: The world is still; no one remains nearby.",
                messageState: { lastResponders: [], activeCharacters: new Set() },
                chatState: { responseHistory: this.responseHistory, characterStatus: this.characterStatus }
            };
        }

        const fullHistory = this.chat.history.map((msg: Message) => 
            `${msg.content || ""}`
        ).join("\n");

        const characterInfo = Object.keys(this.characters)
            .filter(id => !this.characters[id].isRemoved)
            .map(id => {
                const char = this.characters[id];
                return `${char.name}:\nTraits: ${char.personality || "None"}\nDescription: ${char.description || "No details"}\nScenario: ${char.scenario || "Unspecified"}`;
            }).join("\n\n");

        const stageDirections = `System: Create a dynamic scene with natural character interactions.

Chat History:
${fullHistory || "The journey begins."}

Characters:
${characterInfo}

Rules:
1. Characters should interact naturally based on their traits and the situation
2. Include both dialogue and actions
3. Format: **{{Name}}** *action/emotion* "Dialogue" (if speaking)

Craft a scene that flows naturally:`;

        return {
            stageDirections,
            messageState: { 
                lastResponders: participants,
                activeCharacters: new Set(Object.keys(this.characters).filter(id => !this.characters[id].isRemoved))
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    { responders: participants, messageContent: userMessage.content, timestamp: Date.now() }
                ],
                characterStatus: this.characterStatus
            }
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const participants = new Set<string>();
        if (this.responseHistory.length > 0) {
            const lastEntry = this.responseHistory[this.responseHistory.length - 1];
            lastEntry.messageContent = botMessage.content;

            const charPattern = /\*\*{{([^}]+)}}\*\*/g;
            let match;
            while ((match = charPattern.exec(botMessage.content || "")) !== null) {
                const charName = match[1];
                const charId = Object.keys(this.characters).find(id => this.characters[id].name === charName);
                if (charId) participants.add(charId);
            }
            lastEntry.responders = Array.from(participants);
        }

        return {
            modifiedMessage: botMessage.content,
            error: null,
            chatState: { responseHistory: this.responseHistory, characterStatus: this.characterStatus }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

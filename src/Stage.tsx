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
    maxActive: number;
    activityChance: number;
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
    characterStatus: { [key: string]: { state: "active" | "away" | "busy"; activity?: string } };
    worldState: { setting?: string };
};

type ActionCategory = "explore" | "interact" | "rest" | "work";

/***
 A simple example class that implements the interfaces necessary for a Stage.
 If you want to rename it, be sure to modify App.js as well.
 @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/stage.ts
 ***/
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    private characterStatus: ChatStateType['characterStatus'] = {};
    private worldState: ChatStateType['worldState'] = { setting: "" };
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
        this.characters = data.characters;
        this.config = {
            maxActive: 4,
            activityChance: 70,
            ...(data.config || {})
        };
        this.config.maxActive = Math.max(2, Math.min(15, this.config.maxActive));
        this.config.activityChance = Math.max(10, Math.min(100, this.config.activityChance));
        this.characterStatus = data.chatState?.characterStatus || {};
        this.worldState = data.chatState?.worldState || { setting: "" };

        Object.keys(this.characters).forEach(id => {
            if (!this.characterStatus[id]) {
                this.characterStatus[id] = { state: "active" };
            }
        });
    }

    private selectSceneParticipants(message: Message): string[] {
        const availableChars = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (availableChars.length < 2) return [];

        let mainResponder = availableChars.find(id => 
            message.content?.toLowerCase().includes(this.characters[id].name.toLowerCase()) && 
            this.characterStatus[id].state === "active"
        );
        if (!mainResponder) {
            const activeChars = availableChars.filter(id => this.characterStatus[id].state === "active");
            mainResponder = activeChars[Math.floor(Math.random() * activeChars.length)] || availableChars[0];
        }

        const participants = [mainResponder];
        const remainingChars = availableChars.filter(id => id !== mainResponder);
        let currentProb = this.config.activityChance / 100;

        while (participants.length < this.config.maxActive && remainingChars.length > 0 && Math.random() < currentProb) {
            const nextChar = remainingChars[Math.floor(Math.random() * remainingChars.length)];
            const desc = this.characters[nextChar].description?.toLowerCase() || "";
            const pers = this.characters[nextChar].personality?.toLowerCase() || "";
            const leaveChance = (desc.includes("restless") || pers.includes("curious")) ? 0.2 : 0.1;

            if (Math.random() < leaveChance && this.characterStatus[nextChar].state === "active") {
                this.characterStatus[nextChar].state = "away";
                this.characterStatus[nextChar].activity = this.generateActivity(nextChar);
            } else {
                participants.push(nextChar);
            }
            remainingChars.splice(remainingChars.indexOf(nextChar), 1);
            currentProb *= 0.7;
        }

        availableChars.filter(id => this.characterStatus[id].state === "away").forEach(id => {
            if (Math.random() < 0.1) {
                this.characterStatus[id].state = "active";
                this.characterStatus[id].activity = undefined;
            }
        });

        return participants;
    }

    private generateActivity(charId: string): string {
        const char = this.characters[charId];
        const desc = char.description?.toLowerCase() || "";
        const pers = char.personality?.toLowerCase() || "";
        const setting = this.worldState.setting?.toLowerCase() || "";

        const actions: Record<ActionCategory, string[]> = {
            explore: ["scouting the horizon", "pacing the edge", "searching the shadows"],
            interact: ["chatting with a stranger", "trading a quick word", "gesturing animatedly"],
            rest: ["leaning against a wall", "sitting in thought", "watching the scene"],
            work: ["sharpening a tool", "sketching a map", "mending a tear"]
        };

        let category: ActionCategory = "explore";
        if (desc.includes("social") || pers.includes("friendly")) category = "interact";
        if (desc.includes("calm") || pers.includes("quiet")) category = "rest";
        if (desc.includes("craft") || setting.includes("camp")) category = "work";

        const actionList = actions[category];
        return actionList[Math.floor(Math.random() * actionList.length)];
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
                error: "Need at least 2 characters for interaction.",
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
            chatState: { characterStatus: this.characterStatus, worldState: this.worldState }
        };
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const participants = this.selectSceneParticipants(userMessage);
        if (participants.length === 0) {
            return {
                stageDirections: "System: No available characters.",
                messageState: { lastResponders: [] },
                chatState: { characterStatus: this.characterStatus, worldState: this.worldState }
            };
        }

        if (!this.worldState.setting) {
            this.worldState.setting = userMessage.content.split(",").shift() || "";
        }

        const characterInfo = Object.keys(this.characters)
            .filter(id => !this.characters[id].isRemoved)
            .map(id => {
                const char = this.characters[id];
                const status = this.characterStatus[id];
                return `${char.name}:\nPersonality: ${char.personality || ""}\nDescription: ${char.description || ""}\nScenario: ${char.scenario || ""}\nStatus: ${status.state}${status.activity ? ` (${status.activity})` : ""}`;
            }).join("\n\n");

        const stageDirections = `Characters:
${characterInfo}

Setting: ${this.worldState.setting}

Rules:
1. Main character (${this.characters[participants[0]].name}) responds first
2. Up to ${this.config.maxActive} characters can join, ${this.config.activityChance}% chance each
3. Characters can be active, away, or busy
4. Format: **[Name]:** *action/emotion* "Dialogue" [expression]`;

        return {
            stageDirections,
            messageState: { lastResponders: participants },
            chatState: { characterStatus: this.characterStatus, worldState: this.worldState }
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        // No state updates needed as we track everything in chatState
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const filteredContent = botMessage.content.replace(
            /\*\*\[([^:]+)\]:\*\*/g,
            (match, charName) => {
                const charId = Object.keys(this.characters).find(id => this.characters[id].name === charName);
                return charId && this.characterStatus[charId].state === "active" ? match : `*${charName} is away*`;
            }
        );

        const statusUpdates = Object.entries(this.characterStatus)
            .filter(([_, status]) => status.state === "away")
            .map(([id, status]) => `${this.characters[id].name} ${status.activity || "is away"}.`)
            .join(" ");
        const systemMessage = statusUpdates ? `System: ${statusUpdates}` : null;

        return {
            modifiedMessage: filteredContent,
            systemMessage,
            chatState: { characterStatus: this.characterStatus, worldState: this.worldState }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

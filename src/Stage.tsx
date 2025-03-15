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
    characterStatus: { [key: string]: { state: "active" | "away" | "busy"; activity?: string } };
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
        this.characterStatus = data.chatState?.characterStatus || {};
        this.chat = { history: [] };

        Object.keys(this.characters).forEach(id => {
            if (!this.characterStatus[id]) {
                this.characterStatus[id] = { state: "active" };
            }
        });

        console.debug('Stage initialized with config:', this.config);
    }

    async setState(state: MessageStateType): Promise<void> {
        // No state updates needed as we track everything in chatState
    }

    private selectSceneParticipants(message: Message): string[] {
        const availableChars = Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
        if (availableChars.length === 0) return [];

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
        console.debug('Initial join probability:', currentProb);

        while (
            participants.length < this.config.maxActive &&
            remainingChars.length > 0 &&
            Math.random() < currentProb
        ) {
            const nextChar = remainingChars[Math.floor(Math.random() * remainingChars.length)];
            const desc = this.characters[nextChar].description?.toLowerCase() || "";
            const pers = this.characters[nextChar].personality?.toLowerCase() || "";
            const leaveChance = (desc.includes("restless") || pers.includes("independent")) ? 0.15 : 0.05;

            if (Math.random() < leaveChance && this.characterStatus[nextChar].state === "active") {
                this.characterStatus[nextChar].state = Math.random() < 0.5 ? "away" : "busy";
                console.debug(`${this.characters[nextChar].name} left the scene`);
            } else {
                participants.push(nextChar);
                console.debug(`${this.characters[nextChar].name} joined the scene`);
            }
            remainingChars.splice(remainingChars.indexOf(nextChar), 1);
            
            currentProb *= this.config.activityChance / 100;
            console.debug('Updated join probability:', currentProb);
        }

        availableChars.filter(id => this.characterStatus[id].state !== "active").forEach(id => {
            const desc = this.characters[id].description?.toLowerCase() || "";
            const returnChance = desc.includes("loyal") ? 0.1 : 0.03;
            if (Math.random() < returnChance) {
                this.characterStatus[id].state = "active";
                console.debug(`${this.characters[id].name} returned to active state`);
            }
        });

        const activeParticipants = participants.filter(id => this.characterStatus[id].state === "active");
        console.debug('Final participants:', activeParticipants.map(id => this.characters[id].name));
        
        return activeParticipants;
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
                const status = this.characterStatus[id];
                return `${char.name}:\nTraits: ${char.personality || "None"}\nDescription: ${char.description || "No details"}\nScenario: ${char.scenario || "Unspecified"}\nStatus: ${status.state}`;
            }).join("\n\n");

        const modifiedMessage = participants.some(id => userMessage.content?.toLowerCase().includes(this.characters[id].name.toLowerCase()))
            ? `[${participants.map(id => this.characters[id].name).join(", ")}]: ${userMessage.content}`
            : userMessage.content;

        const stageDirections = `System: Weave a living, breathing world scene that unfolds naturally.

Chat History (first message sets the world):
${fullHistory || "The journey starts here."}

Characters and Their Status:
${characterInfo}

Rules for Scene Generation:
1. **User's Call**: At least one active character (${this.characters[participants[0]].name}) reacts to "${userMessage.content}" if it aligns with their traits, scenario, or status; otherwise, they may ignore it.
2. **World Alive**:
   - Up to ${this.config.maxActive} characters can be active, with a ${this.config.activityChance}% chance for each additional one to join (decreasing each step).
   - Not all must speak; some act silently based on their personality, scenario, or status.
   - Characters pursue their own paths, shaped by traits and past events, even if unrelated to the user.
3. **Natural Unfolding**:
   - Blend reactions to the user with independent actions or interactions among characters.
   - Characters may leave or return based on their status; those "away" or "busy" remain silent.
   - Reflect personality (e.g., "stubborn" resists, "curious" explores) and scenario in behavior.
4. **Format**: Merge narrative and dialogue:
   - **{{Name}}** *action/emotion* "Dialogue" (if speaking)
   - *Name does something* (if silent)

Craft a scene that flows like a chapter, tied to the history and characters' lives:`;

        return {
            stageDirections,
            modifiedMessage,
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

        const statusUpdates = Object.entries(this.characterStatus)
            .filter(([id, status]) => status.state !== "active" && !participants.has(id))
            .map(([id, status]) => `**{{${this.characters[id].name}}}** is ${status.state}.`)
            .join(" ");
        const systemMessage = statusUpdates ? `System: ${statusUpdates}` : null;

        return {
            modifiedMessage: botMessage.content,
            systemMessage,
            error: null,
            chatState: { responseHistory: this.responseHistory, characterStatus: this.characterStatus }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

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
    characterStates: {[key: string]: {
        isPresent: boolean;     // Whether the character is present in the scene
        currentActivity?: string; // What the character is currently doing
        location?: string;      // Where the character currently is
        lastSeen?: number;      // Timestamp when character was last active
    }};  // Dynamic states of characters
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
    private characterStates: MessageStateType['characterStates'] = {};

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, undefined>) {
        /***
         This is the first thing called in the stage,
         to create an instance of it.
         The definition of InitialData is at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/initial.ts
         Character at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/character.ts
         User at @link https://github.com/CharHubAI/chub-stages-ts/blob/main/src/types/user.ts
         ***/
        super(data);
        const { characters, chatState, messageState } = data;
        
        this.characters = characters;
        this.responseHistory = chatState?.responseHistory || [];
        
        // Initialize character states if they don't exist
        if (messageState?.characterStates) {
            this.characterStates = messageState.characterStates;
        } else {
            // Initialize all characters as present by default
            Object.keys(characters).forEach(id => {
                if (!characters[id].isRemoved) {
                    this.characterStates[id] = {
                        isPresent: true,
                        currentActivity: 'conversing',
                        location: 'main area',
                        lastSeen: Date.now()
                    };
                }
            });
        }
    }

    private getAvailableCharacters(): string[] {
        return Object.keys(this.characters).filter(id => !this.characters[id].isRemoved);
    }

    private getActiveCharacters(): string[] {
        // Get characters who are currently present in the scene
        return Object.keys(this.characterStates).filter(id => 
            !this.characters[id].isRemoved && this.characterStates[id].isPresent
        );
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

    private updateCharacterStates(messageContent: string): void {
        const now = Date.now();
        const availableChars = this.getAvailableCharacters();
        
        // Update last seen for all characters who participated
        Object.keys(this.characterStates).forEach(id => {
            if (this.characterStates[id].isPresent) {
                this.characterStates[id].lastSeen = now;
            }
        });
        
        // Look for context clues about character movements
        const leavePatterns = [
            /\b(leaves|left|exited|departed|walked out|gone|went away)\b/i,
            /\bgoing to\s+([^,.]+)/i,
            /\bheaded (to|towards)\s+([^,.]+)/i
        ];
        
        const returnPatterns = [
            /\b(returns|returned|came back|arrived|entered|appeared)\b/i,
            /\bjoined\s+([^,.]+)/i
        ];
        
        const privatePatterns = [
            /\bprivate\s+([^,.]+)/i,
            /\balone with\s+([^,.]+)/i,
            /\bin private\b/i,
            /\bjust the two of us\b/i
        ];
        
        // Check for characters leaving
        availableChars.forEach(id => {
            const charName = this.characters[id].name.toLowerCase();
            
            // Check if character is mentioned as leaving
            leavePatterns.forEach(pattern => {
                const leaveRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                if (leaveRegex.test(messageContent)) {
                    this.characterStates[id] = {
                        ...this.characterStates[id],
                        isPresent: false,
                        lastSeen: now
                    };
                    
                    // Try to extract where they went
                    const matches = messageContent.match(leaveRegex);
                    if (matches && matches[1]) {
                        this.characterStates[id].currentActivity = `went to ${matches[1]}`;
                        this.characterStates[id].location = matches[1];
                    } else {
                        this.characterStates[id].currentActivity = 'away';
                    }
                }
            });
            
            // Check if character is mentioned as returning
            returnPatterns.forEach(pattern => {
                const returnRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                if (returnRegex.test(messageContent)) {
                    this.characterStates[id] = {
                        ...this.characterStates[id],
                        isPresent: true,
                        currentActivity: 'conversing',
                        location: 'main area',
                        lastSeen: now
                    };
                }
            });
        });
        
        // Check for private conversations
        privatePatterns.forEach(pattern => {
            const privateMatch = messageContent.match(pattern);
            if (privateMatch) {
                // Make most characters temporarily absent for private conversation
                availableChars.forEach(id => {
                    const charName = this.characters[id].name.toLowerCase();
                    // If character is not mentioned in private conversation, mark as absent
                    if (!messageContent.toLowerCase().includes(charName)) {
                        this.characterStates[id] = {
                            ...this.characterStates[id],
                            isPresent: false,
                            currentActivity: 'giving privacy',
                            lastSeen: now
                        };
                    }
                });
            }
        });
        
        // Randomly have characters leave or return based on time (for more dynamic world)
        const randomChance = 0.1; // 10% chance per message
        if (Math.random() < randomChance) {
            const randomCharId = availableChars[Math.floor(Math.random() * availableChars.length)];
            if (randomCharId) {
                const isCurrentlyPresent = this.characterStates[randomCharId].isPresent;
                
                // If present, might leave
                if (isCurrentlyPresent) {
                    const activities = ['getting a drink', 'checking something', 'taking a break', 'attending to something'];
                    const randomActivity = activities[Math.floor(Math.random() * activities.length)];
                    
                    this.characterStates[randomCharId] = {
                        ...this.characterStates[randomCharId],
                        isPresent: false,
                        currentActivity: randomActivity,
                        lastSeen: now
                    };
                } 
                // If absent, might return
                else {
                    // Only return if they've been gone for a while
                    const timeGone = now - (this.characterStates[randomCharId].lastSeen || 0);
                    if (timeGone > 2 * 60 * 1000) { // 2 minutes
                        this.characterStates[randomCharId] = {
                            ...this.characterStates[randomCharId],
                            isPresent: true,
                            currentActivity: 'conversing',
                            location: 'main area',
                            lastSeen: now
                        };
                    }
                }
            }
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Update character states based on message content
        this.updateCharacterStates(userMessage.content);
        
        // Get characters who are currently present
        const activeChars = this.getActiveCharacters();
        
        // Get character names for explicit reference
        const characterNames = activeChars.map(id => this.characters[id].name);
        
        // Format full chat history for context
        // We'll use the entire history stored in responseHistory
        const fullHistory = this.responseHistory
            .map(entry => {
                if (entry.responders.length === 0) {
                    return `User: ${entry.messageContent || ''}`;
                } else {
                    return entry.messageContent || '';
                }
            })
            .filter(msg => msg.trim() !== '')
            .join("\n\n");

        // Format character information with detailed descriptions
        const characterInfo = activeChars
            .map(id => {
                const char = this.characters[id];
                return `${char.name}:
Personality: ${char.personality || 'Not specified'}
Description: ${char.description || 'Not specified'}
${char.scenario ? `Current scenario: ${char.scenario}` : ''}
Current status: ${this.characterStates[id].currentActivity || 'conversing'}`;
            }).join("\n\n");
            
        // Get information about absent characters
        const absentCharacters = this.getAvailableCharacters()
            .filter(id => !activeChars.includes(id))
            .map(id => {
                const char = this.characters[id];
                return `${char.name} (${this.characterStates[id].currentActivity || 'away'})`;
            });

        const stageDirections = `System: You are facilitating a dynamic group conversation where characters come and go naturally, just like in real life. Your task is to create a realistic group dynamic where only the currently present characters interact with each other.

CURRENTLY PRESENT CHARACTERS (ONLY USE THESE):
${characterInfo}

${absentCharacters.length > 0 ? `CHARACTERS CURRENTLY ABSENT (DO NOT INCLUDE THESE IN DIALOGUE):
${absentCharacters.join(', ')}` : ''}

CONVERSATION HISTORY:
${fullHistory}

New message from User: "${userMessage.content}"

CRITICAL RULES:
1. DO NOT GENERATE ANY USER RESPONSES OR DIALOGUE. The user has already provided their message above.
2. ONLY generate responses from the CURRENTLY PRESENT characters listed above. NEVER speak as the user.
3. DO NOT include absent characters in the dialogue - they are not present in the scene.
4. Characters may reference absent characters ("I wonder where X went") but absent characters CANNOT speak.

WORLD DYNAMICS:
- Characters naturally come and go from conversations
- Characters have their own lives and activities outside the main conversation
- The environment feels like a living, breathing space where people move around
- Characters might mention what absent characters are doing or where they went
- Characters might notice when others leave or return to the conversation

CHARACTER AUTHENTICITY:
- Each character MUST act according to THEIR OWN description and personality
- Characters should have distinct voices, opinions, and reactions
- Characters should maintain consistent personalities throughout
- Characters' responses should reflect their background and traits
- NO character should act out of character or contradict their description

INTERACTIVE DYNAMICS:
- Characters MUST REACT to each other's statements and emotions
- Show characters responding directly to what other characters say
- Include interruptions, agreements, disagreements based on character relationships
- Characters should address each other by name and reference each other's points
- Create natural back-and-forth exchanges between multiple characters

FORMAT REQUIREMENTS:
**{{Character Name}}** *emotional state/action* Their dialogue that reflects their personality
**{{Another Character}}** *reaction to previous character* Their response that shows they're listening
**{{Third Character}}** *action showing personality* Their contribution to the conversation
[Ensure dialogue flows naturally between characters with clear reactions to each other]

IMPORTANT: Create a group conversation where ONLY THE PRESENT CHARACTERS (${characterNames.join(", ")}) interact with each other. Each character must speak and act according to their own personality. DO NOT include any dialogue from absent characters or the user.`;

        // Store the user's message in the response history
        const userEntry: {
            responders: string[];
            messageContent?: string;
            timestamp: number;
        } = { 
            responders: [],  // Empty array indicates user message
            messageContent: userMessage.content,
            timestamp: Date.now()
        };

        return {
            stageDirections,
            messageState: { 
                lastResponders: activeChars,
                activeCharacters: new Set(activeChars),
                characterStates: this.characterStates
            },
            chatState: {
                responseHistory: [
                    ...this.responseHistory,
                    userEntry
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
        
        // Update character states
        if (state?.characterStates) {
            this.characterStates = state.characterStates;
        }
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Update character states based on the response
        this.updateCharacterStates(botMessage.content);
        
        // Store the bot's response in the response history
        const botEntry: {
            responders: string[];
            messageContent?: string;
            timestamp: number;
        } = { 
            responders: [],  // We'll extract participants below
            messageContent: botMessage.content,
            timestamp: Date.now()
        };

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
                
                // Update character state to ensure they're marked as present
                if (this.characterStates[charId]) {
                    this.characterStates[charId].isPresent = true;
                    this.characterStates[charId].lastSeen = Date.now();
                    this.characterStates[charId].currentActivity = 'conversing';
                }
            }
        }

        // Update responders with actual participants
        botEntry.responders = Array.from(participants);

        // Check if there are any user mentions in the response and remove them
        const userPattern = /\*\*{{User}}\*\*|\*\*{{user}}\*\*|\*\*{{YOU}}\*\*|\*\*{{You}}\*\*/g;
        let modifiedContent = botMessage.content;
        if (userPattern.test(modifiedContent)) {
            // Remove any sections with user dialogue
            modifiedContent = modifiedContent.replace(/\*\*{{(?:User|user|YOU|You)}}\*\*.*?(?=\*\*{{|$)/gs, '');
            // Clean up any double newlines that might have been created
            modifiedContent = modifiedContent.replace(/\n\s*\n\s*\n/g, '\n\n');
        }

        // Add the bot response to history
        const updatedHistory = [...this.responseHistory, botEntry];
        this.responseHistory = updatedHistory;

        return {
            modifiedMessage: modifiedContent,
            error: null,
            systemMessage: null,
            chatState: {
                responseHistory: updatedHistory
            },
            messageState: {
                lastResponders: Array.from(participants),
                activeCharacters: new Set(this.getActiveCharacters()),
                characterStates: this.characterStates
            }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

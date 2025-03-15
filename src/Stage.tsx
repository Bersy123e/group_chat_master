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
        
        const activityPatterns = [
            /\b(reading|writing|drawing|playing|working|cooking|eating|drinking|sleeping|resting|thinking|watching|listening)\b/i,
            /\b(busy with|occupied with|engaged in|focused on)\s+([^,.]+)/i
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
            
            // Check if character is mentioned as doing an activity
            activityPatterns.forEach(pattern => {
                const activityRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                if (activityRegex.test(messageContent)) {
                    const matches = messageContent.match(activityRegex);
                    if (matches && matches[1]) {
                        this.characterStates[id] = {
                            ...this.characterStates[id],
                            currentActivity: matches[1],
                            lastSeen: now
                        };
                    } else if (matches && matches[2]) {
                        this.characterStates[id] = {
                            ...this.characterStates[id],
                            currentActivity: matches[2],
                            lastSeen: now
                        };
                    }
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
        const randomChance = 0.15; // 15% chance per message
        if (Math.random() < randomChance) {
            const randomCharId = availableChars[Math.floor(Math.random() * availableChars.length)];
            if (randomCharId) {
                const isCurrentlyPresent = this.characterStates[randomCharId].isPresent;
                
                // If present, might leave or start an activity
                if (isCurrentlyPresent) {
                    const activities = [
                        'getting a drink', 'checking something', 'taking a break', 
                        'attending to something', 'reading a book', 'looking out the window',
                        'organizing their belongings', 'writing something down',
                        'preparing food', 'fixing something', 'lost in thought'
                    ];
                    const randomActivity = activities[Math.floor(Math.random() * activities.length)];
                    
                    // 50% chance to leave, 50% chance to stay but be engaged in activity
                    if (Math.random() < 0.5) {
                        this.characterStates[randomCharId] = {
                            ...this.characterStates[randomCharId],
                            isPresent: false,
                            currentActivity: randomActivity,
                            lastSeen: now
                        };
                    } else {
                        this.characterStates[randomCharId] = {
                            ...this.characterStates[randomCharId],
                            currentActivity: randomActivity,
                            lastSeen: now
                        };
                    }
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

        // Determine if we should focus on the user's message or create an ambient scene
        // If user's message is short or a greeting, we might focus more on ambient world
        const isAmbientFocused = 
            userMessage.content.length < 15 || 
            /^(hi|hello|hey|greetings|sup|yo|what's up|how are you)/i.test(userMessage.content) ||
            this.responseHistory.length % 3 === 0; // Every 3rd message, focus more on ambient world

        const stageDirections = `System: You are creating a UNIFIED DYNAMIC SCENE with natural interactions between characters. Your task is to generate a realistic snapshot of a living world where characters interact with each other and their environment in a single flowing narrative.

CURRENTLY PRESENT CHARACTERS (ONLY USE THESE):
${characterInfo}

${absentCharacters.length > 0 ? `CHARACTERS CURRENTLY ABSENT (DO NOT INCLUDE THESE IN DIALOGUE):
${absentCharacters.join(', ')}` : ''}

CONVERSATION HISTORY:
${fullHistory}

New message from User: "${userMessage.content}"

CRITICAL RULES:
1. DO NOT GENERATE ANY USER RESPONSES OR DIALOGUE. The user has already provided their message above.
2. NEVER use **{{User}}** or any variation to make the user speak. The user speaks for themselves only.
3. CREATE ONLY ONE COMBINED RESPONSE, not separate responses from each character.
4. ONLY use the CURRENTLY PRESENT characters listed above. NEVER speak as the user.
5. DO NOT include absent characters in the dialogue - they are not present in the scene.
6. Characters may reference absent characters but absent characters CANNOT speak or act.
7. ${isAmbientFocused ? 'FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on the user\'s message.' : 'Balance responding to the user with character interactions and world activities.'}

CREATING A UNIFIED DYNAMIC SCENE:
- Create a SINGLE FLUID SCENE rather than separate character responses
- Characters should interact SIMULTANEOUSLY (interrupting each other, reacting to others' remarks)
- Mix dialogue with actions, reactions, and environmental interactions
- Show multiple characters engaged in the SAME conversation or activity
- Create a sense of SHARED SPACE where characters are aware of each other

INTERACTION TECHNIQUES:
- Show characters INTERRUPTING each other mid-sentence
- Include PARALLEL CONVERSATIONS happening simultaneously
- Show characters REACTING NONVERBALLY to what others are saying
- Include moments when characters FINISH EACH OTHER'S SENTENCES
- Show characters TALKING WHILE DOING other activities
- Include BACKGROUND ACTIVITIES that continue throughout the scene
- Show characters AGREEING/DISAGREEING with each other through words and actions

SCENE STRUCTURE:
- Start with a brief SETTING DESCRIPTION that establishes the atmosphere
- WEAVE together dialogue and actions rather than separating them by character
- Create NATURAL TRANSITIONS between character interactions
- Include ENVIRONMENTAL DETAILS that characters interact with
- End with a sense of ONGOING ACTIVITY rather than conclusion

RESPONSE FORMAT:
- Use *italics* for describing actions and settings
- Use **{{Character Name}}** to indicate the speaking character
- NEVER use **{{User}}** or any variation - the user is not a character
- Combine actions and dialogue into a single narrative flow
- DO NOT separate responses by character - create a UNIFIED SCENE

EXAMPLES OF DYNAMIC INTERACTIONS:

Example 1 - Characters interrupting each other:
*The afternoon sun filters through dusty windows as the group gathers in the living room*

**{{Character1}}** *leaning forward in her chair* "I think we should consider the implications of—"

**{{Character2}}** *interrupts, waving a hand dismissively* "That's exactly what they want us to think! Listen, the real issue here is..." *glances at Character3 for support*

**{{Character3}}** *nodding while arranging books on a nearby shelf* "He's got a point. Remember when we tried that approach last month?"

Example 2 - Simultaneous activities:
*Rain patters against the windows as the group finds various ways to pass the time*

**{{Character1}}** *sketching in a notebook while speaking without looking up* "Has anyone seen my blue pencil? I could have sworn I left it right here..."

**{{Character2}}** *passes a cup of tea to Character3 before responding* "Check under the sofa. Everything ends up there eventually."

**{{Character3}}** *accepting the tea with a grateful nod* "Thanks. And speaking of lost things, did anyone ever figure out what happened to that old map we had?"

Example 3 - Reactions and environment:
*The fireplace crackles, casting dancing shadows across the room*

**{{Character1}}** *warming hands by the fire* "So what do you make of the question about—"

**{{Character2}}** *snorts and rolls eyes while shuffling a deck of cards* "Another wild theory, if you ask me."

**{{Character1}}** *turns with raised eyebrow* "You don't think there's any merit to it?"

**{{Character3}}** *looking up from a thick book, adjusting glasses* "Actually, there might be something to it. Remember that passage we found..."

IMPORTANT: Create a UNIFIED, DYNAMIC SCENE where the characters (${characterNames.join(", ")}) naturally interact with each other and their environment. Focus on creating a CONTINUOUS FLOW of interaction rather than separate character responses. The scene should feel like a snapshot of a living world where multiple things happen simultaneously. NEVER make the user speak or act - they are not a character in your response.`;

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
            // Skip if this is a user mention
            if (/^(User|user|YOU|You)$/.test(charName)) {
                continue;
            }
            
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

        // Check if there are any user mentions or dialogue in the response and remove them
        // More comprehensive pattern to catch user mentions and any dialogue attributed to the user
        const userPatterns = [
            /\*\*{{(?:User|user|YOU|You)}}\*\*\s*(?:\*[^*]*\*)?\s*"[^"]*"/g,  // User dialogue with action
            /\*\*{{(?:User|user|YOU|You)}}\*\*\s*"[^"]*"/g,  // User dialogue without action
            /\*\*{{(?:User|user|YOU|You)}}\*\*/g,  // Just user mention
            /\*\s*(?:User|user|YOU|You)[^*]*\*/g,  // User in action descriptions
            /\b(?:User|user|YOU|You)\s+(?:says|said|asks|asked|replies|replied|responds|responded|speaks|spoke)\b/gi  // Narrative about user speaking
        ];
        
        let modifiedContent = botMessage.content;
        let userContentDetected = false;
        
        // Apply all patterns to remove user dialogue and mentions
        userPatterns.forEach(pattern => {
            if (pattern.test(modifiedContent)) {
                userContentDetected = true;
                modifiedContent = modifiedContent.replace(pattern, '');
            }
        });
        
        // Clean up any artifacts from the removal
        if (userContentDetected) {
            modifiedContent = modifiedContent
                // Remove empty lines
                .replace(/\n\s*\n\s*\n/g, '\n\n')
                // Remove lines that only have punctuation left
                .replace(/\n[^\w\n]*\n/g, '\n\n')
                // Fix any double spaces
                .replace(/  +/g, ' ')
                // Fix any lines starting with punctuation due to removed text
                .replace(/\n\s*[,.;:!?]/g, '\n');
        }
        
        // Add the bot response to history
        const updatedHistory = [...this.responseHistory, botEntry];
        this.responseHistory = updatedHistory;

        // We'll handle this internally in the next prompt instead of showing a visible message
        // This prevents the system message from appearing to users
        const hasUserContent = userContentDetected;

        return {
            modifiedMessage: modifiedContent,
            error: null,
            systemMessage: null, // No visible system message
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

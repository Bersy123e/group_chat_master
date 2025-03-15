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
        
        // Format FULL chat history for context - no limits
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

        // More detailed character descriptions including all available information
        const characterDescriptions = activeChars
            .map(id => {
                const char = this.characters[id];
                let description = `${char.name}:\n`;
                
                if (char.personality) {
                    description += `Personality: ${char.personality}\n`;
                }
                
                if (char.description) {
                    description += `Description: ${char.description}\n`;
                }
                
                if (char.scenario) {
                    description += `Scenario: ${char.scenario}\n`;
                }
                
                if (char.example_dialogs) {
                    description += `Example dialogue: ${char.example_dialogs}\n`;
                }
                
                // Add current state information
                description += `Current status: ${this.characterStates[id].currentActivity || 'conversing'}\n`;
                description += `Current location: ${this.characterStates[id].location || 'main area'}\n`;
                
                return description;
            }).join("\n\n");
            
        // More detailed information about absent characters
        const absentCharactersInfo = this.getAvailableCharacters()
            .filter(id => !activeChars.includes(id))
            .map(id => {
                const char = this.characters[id];
                return `${char.name} (${this.characterStates[id].currentActivity || 'away'} at ${this.characterStates[id].location || 'unknown location'})`;
            });

        // Determine if we should focus on the user's message or create an ambient scene
        // If user's message is short or a greeting, we might focus more on ambient world
        const isAmbientFocused = 
            userMessage.content.length < 15 || 
            /^(hi|hello|hey|greetings|sup|yo|what's up|how are you)/i.test(userMessage.content) ||
            this.responseHistory.length % 3 === 0; // Every 3rd message, focus more on ambient world

        // Character relationships - inferred from history
        const characterRelationships = `The characters have a shared history and ongoing relationships based on their previous interactions. They should reference past conversations and events when appropriate, building on established dynamics.`;

        const stageDirections = `System: You are creating a UNIFIED NARRATIVE SCENE with natural interactions between characters. Your task is to generate a realistic, book-like narrative where characters interact with each other and their environment in a flowing, coherent story.

CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

FULL CONVERSATION HISTORY:
${fullHistory}

New message from User: "${userMessage.content}"

CRITICAL RULES:
1. DO NOT GENERATE ANY USER RESPONSES OR DIALOGUE. The user has already provided their message above.
2. NEVER use **{{User}}** or any variation to make the user speak. The user speaks for themselves only.
3. NEVER describe the user's actions, movements, or expressions. The user is not a character in your scene.
4. CREATE ONLY ONE COMBINED NARRATIVE with ALL PRESENT CHARACTERS interacting together.
5. ONLY USE THE EXACT CHARACTERS LISTED ABOVE. DO NOT invent or include any characters not explicitly listed.
6. Each character should act according to their unique personality and description.
7. STRICTLY ENFORCE ABSENCE: If a character is listed as not present, they MUST NOT appear in the scene AT ALL - no dialogue, no actions, no mentions of current activities.
8. Characters may reference absent characters in past tense or wondering where they are, but absent characters CANNOT speak or act.
9. ${isAmbientFocused ? 'FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on the user\'s message.' : 'Balance responding to the user with character interactions and world activities.'}
10. REFERENCE PAST CONVERSATIONS AND EVENTS from the full conversation history when appropriate.
11. AVOID REPETITIVE ACTIONS: Do not have characters perform the same actions repeatedly (like constantly touching under the table, adjusting clothing, etc).

USER INTERACTION RULES:
- The user is NOT a character in your scene - they are an external entity
- NEVER describe what the user is doing, thinking, or feeling
- NEVER make the user perform actions in your response
- NEVER put words in the user's mouth
- Characters can acknowledge or respond to the user's message, but CANNOT interact with the user physically
- Treat the user's message as if it came from outside the scene, like a voice from above

STRICT CHARACTER USAGE:
- ONLY use these exact characters in your response: ${characterNames.join(", ")}
- INCLUDE ALL PRESENT CHARACTERS listed above in your response
- NEVER include absent characters - they are completely removed from the scene
- DO NOT create new characters or mention characters not in the list above
- DO NOT use generic characters like "someone", "a man", "a woman", etc.
- If you need background characters, refer to them as "people" or "others" without giving them dialogue

CREATING A BOOK-LIKE NARRATIVE:
- Write in a flowing, literary style similar to a novel
- Create a SINGLE COHERENT NARRATIVE with ALL PRESENT CHARACTERS interacting
- Characters should interact NATURALLY with varied actions and responses
- Mix dialogue with actions, reactions, and environmental descriptions
- Show multiple characters engaged in the SAME conversation or activity
- Create a sense of SHARED SPACE where characters are aware of each other
- REFERENCE PAST EVENTS AND CONVERSATIONS from the full history when appropriate
- MAINTAIN CONTINUITY with previous scenes and conversations

AVOIDING REPETITIVE ACTIONS:
- DO NOT have characters perform the same actions repeatedly
- VARY physical interactions, gestures, and movements
- If a character touched someone in one way, use different interactions next time
- DIVERSIFY environmental interactions (don't just focus on the same objects)
- CREATE PROGRESSION in the scene rather than cycling through the same actions
- DEVELOP the narrative forward rather than repeating similar beats

NARRATIVE TECHNIQUES:
- Use varied dialogue tags (said, whispered, replied, etc.) to add variety
- Include SENSORY DETAILS (sounds, smells, textures) to enrich the scene
- Show characters REACTING NONVERBALLY to what others are saying
- Include moments of INTERNAL THOUGHTS or EMOTIONS for characters
- Show characters engaged in MEANINGFUL ACTIVITIES related to the setting
- Include ENVIRONMENTAL DETAILS that characters interact with
- Have characters REFERENCE SHARED MEMORIES or past events from the conversation history

SCENE STRUCTURE:
- Start with a brief SETTING DESCRIPTION that establishes the atmosphere
- WEAVE together dialogue and actions from ALL PRESENT CHARACTERS
- Create NATURAL TRANSITIONS between character interactions
- Include ENVIRONMENTAL DETAILS that characters interact with
- End with a sense of ONGOING ACTIVITY rather than conclusion
- MAINTAIN CONTINUITY with previous scenes and conversations

RESPONSE FORMAT:
- Use *italics* for describing actions, settings, and non-dialogue elements
- Use **{{Character Name}}** to indicate the speaking character
- NEVER use **{{User}}** or any variation - the user is not a character
- Combine actions and dialogue from ALL PRESENT CHARACTERS into a single narrative flow
- Format dialogue with proper quotation marks and attribution
- DO NOT separate responses by character - create a UNIFIED NARRATIVE with ALL PRESENT CHARACTERS

EXAMPLES OF NARRATIVE STYLE:

Example 1 - Natural dialogue and varied interactions:
*The afternoon sun filters through dusty windows as the group gathers in the living room. The air is thick with unspoken tension.*

**{{Character1}}** leans forward in her chair, her fingers drumming against the armrest. "I think we should consider the implications of—"

**{{Character2}}** interrupts, waving a hand dismissively. "That's exactly what they want us to think! Listen, the real issue here is..." He glances at Character3 for support, his eyebrows raised expectantly.

*A clock ticks loudly in the corner, marking the uncomfortable silence.*

**{{Character3}}** nods while arranging books on a nearby shelf, her movements deliberate and measured. "He's got a point. Remember when we tried that approach last month? The results were... less than ideal."

Example 2 - Environmental interaction and character development:
*Rain patters against the windows, creating a soothing rhythm that contrasts with the nervous energy in the room. The scent of fresh coffee mingles with the musty smell of old books.*

**{{Character1}}** sketches in a notebook, her pencil moving in quick, confident strokes. Without looking up, she asks, "Has anyone seen my blue pencil? I could have sworn I left it right here..."

*The floorboards creak as Character2 crosses the room, his shadow falling across Character1's drawing.*

**{{Character2}}** passes a steaming cup to Character3 before responding. "Check under the sofa. Everything ends up there eventually." His voice carries a hint of amusement, a private joke between old friends.

**{{Character3}}** accepts the cup with a grateful smile, inhaling the rich aroma. "Thanks. And speaking of lost things, did anyone ever figure out what happened to that old map we had? The one with the strange markings along the eastern border?"

IMPORTANT: Create a UNIFIED, BOOK-LIKE NARRATIVE where ALL PRESENT characters (${characterNames.join(", ")}) naturally interact with each other and their environment. ALWAYS include ALL PRESENT characters listed above in your response. STRICTLY EXCLUDE any absent characters completely. REFERENCE PAST CONVERSATIONS AND EVENTS when appropriate to create continuity. Focus on creating a CONTINUOUS FLOW of interaction rather than separate character responses. VARY character actions and avoid repetitive behaviors. The scene should feel like a chapter from a novel where multiple things happen simultaneously. NEVER make the user speak or act - they are not a character in your response. DO NOT invent new characters not listed above.`;

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

        // Verify that no absent characters were included
        const activeChars = this.getActiveCharacters();
        const absentChars = this.getAvailableCharacters().filter(id => !activeChars.includes(id));
        
        // Check if any absent characters were incorrectly included
        let incorrectlyIncluded = false;
        absentChars.forEach(id => {
            if (participants.has(id)) {
                // Remove them from participants
                participants.delete(id);
                incorrectlyIncluded = true;
            }
        });

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
        if (userContentDetected || incorrectlyIncluded) {
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

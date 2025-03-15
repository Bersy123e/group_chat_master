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
        chatHistory: string,
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
        
        if (chatHistory) {
            prompt += `\nFull chat history:\n${chatHistory}\n`;
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
            /\b(busy with|occupied with|engaged in|focused on)\s+([^,.]+)/i,
            /\b(examining|investigating|studying|observing|contemplating)\s+([^,.]+)/i,
            /\b(sitting|standing|leaning|lying)\s+([^,.]+)/i,
            /\b(smiling|laughing|frowning|crying|shaking)\b/i,
            /\b(silent|quiet|thoughtful|pensive|hesitant)\b/i
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
        
        // Check if this is the first message in the conversation
        const isFirstMessage = this.responseHistory.length === 0;
        
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

        // Определяем основных персонажей, к которым обращено сообщение пользователя
        let primaryResponders: string[] = [];
        activeChars.forEach(id => {
            const charName = this.characters[id].name.toLowerCase();
            const messageContentLower = userMessage.content.toLowerCase();
            
            // Если персонаж напрямую упомянут в сообщении
            if (messageContentLower.includes(charName)) {
                primaryResponders.push(id);
            }
        });

        // Все активные персонажи должны участвовать в сцене
        let respondingCharacterIds = [...activeChars];

        // Более детальные описания персонажей со всей доступной информацией
        const characterDescriptions = activeChars
            .map(id => {
                const char = this.characters[id];
                let description = `${char.name}:\n`;
                
                // Only include the description field as requested
                if (char.description) {
                    description += `${char.description}`;
                }
                
                return description;
            }).join("\n\n");
            
        // Подробная информация об отсутствующих персонажах
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

        // Special instructions for the first message
        const firstMessageInstructions = isFirstMessage ? 
            `This is the FIRST MESSAGE in the conversation. Start by introducing the scene and characters naturally. Establish the setting and initial dynamics between characters. Respond to the user's first message in a way that welcomes them to the conversation.` : '';

        // Указываем основных персонажей, к которым направлено сообщение
        const primaryFocusText = primaryResponders.length > 0 ? 
            `CHARACTERS DIRECTLY ADDRESSED: ${primaryResponders.map(id => this.characters[id].name).join(", ")}` : '';

        const stageDirections = `System: You are creating a UNIFIED NARRATIVE SCENE with natural interactions between characters. Your task is to generate a realistic, book-like narrative where characters interact with each other and their environment in a flowing, coherent story.

${isFirstMessage ? 'FIRST MESSAGE INSTRUCTIONS:\n' + firstMessageInstructions + '\n\n' : ''}CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

${!isFirstMessage ? 'FULL CONVERSATION HISTORY:\n' + fullHistory + '\n\n' : ''}New message from User: "${userMessage.content}"

CRITICAL RULES:
1. DO NOT GENERATE ANY USER RESPONSES OR DIALOGUE. The user has already provided their message above.
2. NEVER use **{{User}}** or any variation to make the user speak. The user speaks for themselves only.
3. NEVER describe the user's actions, movements, or expressions. The user is not a character in your scene.
4. CREATE ONLY ONE COMBINED NARRATIVE with ALL PRESENT CHARACTERS interacting together.
5. ONLY USE THE EXACT CHARACTERS LISTED ABOVE. DO NOT invent or include any characters not explicitly listed.
6. Each character should act according to the description provided.
7. STRICTLY ENFORCE ABSENCE: If a character is listed as not present, they MUST NOT appear in the scene AT ALL - no dialogue, no actions, no mentions of current activities.
8. Characters may reference absent characters in past tense or wondering where they are, but absent characters CANNOT speak or act.
9. ${isAmbientFocused ? 'FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on the user\'s message.' : 'Balance responding to the user with character interactions and world activities.'}
${!isFirstMessage ? '10. REFERENCE PAST CONVERSATIONS AND EVENTS from the full conversation history when appropriate.' : '10. ESTABLISH THE INITIAL SCENE and character dynamics in an engaging way.'}
11. AVOID REPETITIVE ACTIONS: Do not have characters perform the same actions repeatedly (like constantly touching under the table, adjusting clothing, etc).
12. MAINTAIN CONSISTENT FORMATTING: Use the exact same format throughout the entire response.
13. CHARACTERS SHOULD FOCUS ON EACH OTHER, not just on responding to the user's message.
14. DO NOT CREATE ANY NEW CHARACTERS - even for background roles or one-time mentions. Use only the characters listed above.
15. NEVER imply the user is a participant in the scene. Users are external observers who can be acknowledged but not physically interacted with.
${primaryResponders.length > 0 ? '16. While ALL CHARACTERS should participate in the scene, characters who were DIRECTLY ADDRESSED ('+ primaryResponders.map(id => this.characters[id].name).join(", ") +') should acknowledge and respond to the user\'s message more directly.' : ''}

IMPORTANT CHARACTER PARTICIPATION RULES:
- ALL CHARACTERS SHOULD PARTICIPATE IN THE SCENE, but in varying degrees depending on context.
- Not every character needs to speak extensively - some may just react briefly or have smaller roles.
- Characters engaged in activities (${activeChars.map(id => {
  return this.characterStates[id] ? 
    `${this.characters[id].name}: ${this.characterStates[id].currentActivity || 'conversing'}` : 
    `${this.characters[id].name}: conversing`;
}).join(', ')}) may be less verbose but should still be part of the scene.
- Character participation should be based on relevance to the topic, their personality, current activity, and natural flow.
- AVOID having just one character dominate the entire scene - create a balanced, dynamic interaction.

CHARACTER INTERACTION RULES:
- Characters should ACTIVELY INTERACT WITH EACH OTHER, not just respond to the user
- Include internal thoughts and reflections about what other characters say or do
- Characters can ask each other questions, challenge each other's ideas, or build on what others said
- Show characters REACTING to each other's statements within the same response
- Characters should have their own opinions, agreements, and disagreements with each other
- Create DYNAMIC GROUP INTERACTIONS where multiple characters participate in the same conversation thread
- Include non-verbal reactions like facial expressions, body language, or emotional responses to others
- Let characters interrupt or respond directly to each other's remarks when appropriate

USER INTERACTION RULES:
- The user is NOT a character in your scene - they are an external entity
- NEVER describe what the user is doing, thinking, or feeling
- NEVER make the user perform actions in your response
- NEVER put words in the user's mouth
- Characters can acknowledge or respond to the user's message, but CANNOT interact with the user physically
- THE USER SHOULD NOT BE THE CENTRAL FOCUS OF THE CHARACTERS' INTERACTIONS
- Characters should primarily interact with each other and the environment
- Treat the user's message as if it came from outside the scene, like a voice from above

STRICT CHARACTER USAGE:
- ONLY use these exact characters in your response: ${characterNames.join(", ")}
- NOT EVERY CHARACTER NEEDS TO SPEAK - some may be silent or just briefly react
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
${!isFirstMessage ? '- REFERENCE PAST EVENTS AND CONVERSATIONS from the full history when appropriate' : '- ESTABLISH THE SETTING and atmosphere in rich detail'}
- MAINTAIN CONTINUITY with previous scenes and conversations
- MAINTAIN CONSISTENT FORMATTING throughout the entire response

RESPONSE FORMAT:
- Use **Character Name** to indicate who is speaking or acting
- Use *italics* for thoughts, actions, and descriptions (e.g., **Character** *walks slowly to the window*)
- Use "quotes" for dialogue (e.g., **Character** "This is what I think about that.")
- Characters can have internal thoughts about what others say (e.g., **Character** *thinks to herself about what Other Character just said*)
- Characters can react to others within the same turn (e.g., **Character** *raises an eyebrow at Other Character's comment* "I'm not sure that's right.")
- Multiple characters can interact in sequence without the user's intervention
- Descriptions of the environment and scene setting should be in *italics* without character attribution
- CONSISTENTLY use this format throughout the entire response

IMPORTANT: Create a UNIFIED, BOOK-LIKE NARRATIVE where PRESENT characters (${characterNames.join(", ")}) naturally interact with each other and their environment. NOT EVERY CHARACTER NEEDS TO SPEAK - some may just react briefly or remain silent based on their current activity and the context. ${!isFirstMessage ? 'REFERENCE PAST CONVERSATIONS AND EVENTS when appropriate to create continuity.' : 'ESTABLISH THE INITIAL SCENE and character dynamics in an engaging way.'} Focus on creating a CONTINUOUS FLOW of interaction rather than separate character responses. VARY character actions and avoid repetitive behaviors. The scene should feel like a chapter from a novel where multiple things happen simultaneously. NEVER make the user speak or act - they are not a character in your response. DO NOT invent new characters not listed above. MAINTAIN CONSISTENT FORMATTING throughout.`;

        // Store the user's message in the response history
        const userEntry: ChatStateType['responseHistory'][0] = {
            responders: [],
            messageContent: userMessage.content,
            timestamp: Date.now()
        };
        
        this.responseHistory = [
            ...this.responseHistory,
            userEntry
        ];
        
        return {
            stageDirections,
            messageState: {
                // Pass which characters should respond based on context
                lastResponders: respondingCharacterIds,
                activeCharacters: new Set(activeChars),
                characterStates: this.characterStates
            },
            chatState: {
                responseHistory: this.responseHistory
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
        // Используем всех активных персонажей, а не только отвечающих
        const activeChars = this.getActiveCharacters();
        const botEntry: {
            responders: string[];
            messageContent?: string;
            timestamp: number;
        } = {
            responders: activeChars,
            messageContent: botMessage.content,
            timestamp: Date.now()
        };
        
        this.responseHistory = [
            ...this.responseHistory,
            botEntry
        ];
        
        return {
            messageState: {
                lastResponders: activeChars,
                activeCharacters: new Set(activeChars),
                characterStates: this.characterStates
            },
            chatState: {
                responseHistory: this.responseHistory
            }
        };
    }

    render(): ReactElement {
        return <></>;
    }
}

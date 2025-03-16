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
        position?: string;      // Physical position in the scene (sitting, standing, etc.)
        holdingItems?: string[]; // Items the character is currently holding
        interactingWith?: string; // Character or object they're interacting with
        lastAction?: string;    // Last physical action performed
        emotionalState?: string; // Current emotional state
    }};  // Dynamic states of characters
    sceneObjects?: {[key: string]: {
        location: string;       // Where the object is
        lastInteraction?: number; // When it was last interacted with
        interactedBy?: string;   // Who last interacted with it
        state?: string;         // Current state of the object
    }}; // Track objects in the scene
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
    // Добавляем отслеживание действий, требующих временного отсутствия
    private taskTimers: { [key: string]: { task: string, duration: number, startTime: number } } = {};

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
                        lastSeen: Date.now(),
                        position: 'standing',
                        holdingItems: [],
                        emotionalState: 'neutral'
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
        
        // Расширенные шаблоны для обнаружения временных задач
        const temporaryTaskPatterns = [
            /\b(to get|to bring|to fetch|to prepare|to make)\s+([^,.]+)/i,
            /\b(checking on|working on|taking care of)\s+([^,.]+)/i,
            /\b(will be back|be right back|return soon|return in)\b/i,
            /\b(taking orders|serving|cleaning|preparing food|cooking)/i,
            /\b(excuse me while I|let me just|I'll just|one moment while I)\b/i
        ];
        
        const activityPatterns = [
            /\b(reading|writing|drawing|playing|working|cooking|eating|drinking|sleeping|resting|thinking|watching|listening)\b/i,
            /\b(busy with|occupied with|engaged in|focused on)\s+([^,.]+)/i,
            /\b(examining|investigating|studying|observing|contemplating)\s+([^,.]+)/i,
            /\b(sitting|standing|leaning|lying)\s+([^,.]+)/i,
            /\b(smiling|laughing|frowning|crying|shaking)\b/i,
            /\b(silent|quiet|thoughtful|pensive|hesitant)\b/i
        ];
        
        // New patterns for physical positions and interactions
        const positionPatterns = [
            /\b(sits|sat|sitting)\s?(down|on|at)?\s?([^,.]+)?/i,
            /\b(stands|stood|standing)\s?(up|near|by)?\s?([^,.]+)?/i,
            /\b(leans|leaned|leaning)\s?(against|on|over)?\s?([^,.]+)?/i,
            /\b(lies|lay|lying)\s?(down|on)?\s?([^,.]+)?/i,
            /\b(kneels|knelt|kneeling)\s?(down|before|by)?\s?([^,.]+)?/i
        ];
        
        const objectInteractionPatterns = [
            /\b(picks|picked|picking up|takes|took|taking)\s+([^,.]+)/i,
            /\b(puts|put|putting|places|placed|placing)\s+([^,.]+)/i,
            /\b(holds|held|holding)\s+([^,.]+)/i,
            /\b(drops|dropped|dropping)\s+([^,.]+)/i,
            /\b(gives|gave|giving)\s+([^,.]+)\s+(to)\s+([^,.]+)/i,
            /\b(uses|used|using)\s+([^,.]+)/i
        ];
        
        const characterInteractionPatterns = [
            /\b(approaches|approached|approaching)\s+([^,.]+)/i,
            /\b(touches|touched|touching)\s+([^,.]+)/i,
            /\b(hugs|hugged|hugging)\s+([^,.]+)/i,
            /\b(kisses|kissed|kissing)\s+([^,.]+)/i,
            /\b(looks|looked|looking)\s+(at|toward)\s+([^,.]+)/i,
            /\b(smiles|smiled|smiling)\s+(at|to)\s+([^,.]+)/i
        ];
        
        const emotionalStatePatterns = [
            /\b(happy|happily|delighted|excited|thrilled)\b/i,
            /\b(sad|sadly|depressed|upset|disappointed)\b/i,
            /\b(angry|angrily|furious|enraged|irritated)\b/i,
            /\b(scared|afraid|terrified|fearful|anxious)\b/i,
            /\b(surprised|shocked|astonished|amazed|stunned)\b/i,
            /\b(calm|calmly|relaxed|peaceful|tranquil)\b/i
        ];
        
        // Проверяем завершение временных задач
        Object.keys(this.taskTimers).forEach(charId => {
            const taskInfo = this.taskTimers[charId];
            // Если прошло достаточно времени для выполнения задачи
            if (now - taskInfo.startTime >= taskInfo.duration) {
                // Возвращаем персонажа на сцену, если он выполнял временную задачу
                if (!this.characterStates[charId].isPresent) {
                    this.characterStates[charId] = {
                        ...this.characterStates[charId],
                        isPresent: true,
                        currentActivity: 'returning',
                        lastSeen: now
                    };
                }
                // Удаляем таймер задачи, так как она завершена
                delete this.taskTimers[charId];
            }
        });
        
        // Process character changes based on message content
        availableChars.forEach(id => {
            const charName = this.characters[id].name.toLowerCase();
            const charNameRegex = new RegExp(`\\b${charName}\\b`, 'i');
            
            if (messageContent.match(charNameRegex)) {
                // Extract content around character name for context analysis
                const nameIndex = messageContent.toLowerCase().indexOf(charName);
                const startIndex = Math.max(0, nameIndex - 50);
                const endIndex = Math.min(messageContent.length, nameIndex + 100);
                const contextContent = messageContent.substring(startIndex, endIndex);
                
                // Check for position changes
                positionPatterns.forEach(pattern => {
                    const posRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    const match = contextContent.match(posRegex);
                    if (match) {
                        let position = match[1] || '';
                        if (match[3]) position += ' ' + match[3];
                        
                        // Only update if action is a clear change from previous state
                        if (position && (!this.characterStates[id].position || 
                            !this.characterStates[id].position?.includes(position.toLowerCase()))) {
                            this.characterStates[id].position = position.toLowerCase();
                            this.characterStates[id].lastAction = `changed position to ${position}`;
                        }
                    }
                });
                
                // Check for object interactions
                objectInteractionPatterns.forEach(pattern => {
                    const objRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    const match = contextContent.match(objRegex);
                    if (match && match[2]) {
                        const object = match[2].trim();
                        const action = match[1].toLowerCase();
                        
                        // Update holding items based on action
                        if (!this.characterStates[id].holdingItems) {
                            this.characterStates[id].holdingItems = [];
                        }
                        
                        if (action.includes('pick') || action.includes('take') || action.includes('hold')) {
                            if (!this.characterStates[id].holdingItems?.includes(object)) {
                                this.characterStates[id].holdingItems?.push(object);
                            }
                        } else if (action.includes('put') || action.includes('place') || action.includes('drop')) {
                            if (this.characterStates[id].holdingItems) {
                                this.characterStates[id].holdingItems = this.characterStates[id].holdingItems?.filter(
                                    item => !item.includes(object)
                                );
                            }
                        } else if (action.includes('give') && match[4]) {
                            // Handle giving items to others
                            if (this.characterStates[id].holdingItems) {
                                this.characterStates[id].holdingItems = this.characterStates[id].holdingItems?.filter(
                                    item => !item.includes(object)
                                );
                            }
                            
                            // Find recipient character
                            const recipient = match[4].trim().toLowerCase();
                            Object.keys(this.characterStates).forEach(otherId => {
                                if (this.characters[otherId].name.toLowerCase().includes(recipient) && 
                                   this.characterStates[otherId].isPresent) {
                                    if (!this.characterStates[otherId].holdingItems) {
                                        this.characterStates[otherId].holdingItems = [];
                                    }
                                    if (!this.characterStates[otherId].holdingItems?.includes(object)) {
                                        this.characterStates[otherId].holdingItems?.push(object);
                                    }
                                }
                            });
                        }
                        
                        this.characterStates[id].lastAction = `${action} ${object}`;
                    }
                });
                
                // Check for character interactions
                characterInteractionPatterns.forEach(pattern => {
                    const intRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    const match = contextContent.match(intRegex);
                    if (match && match[2]) {
                        const targetName = match[2].trim().toLowerCase();
                        const action = match[1].toLowerCase();
                        
                        // Find if this refers to another character
                        Object.keys(this.characterStates).forEach(otherId => {
                            if (this.characters[otherId].name.toLowerCase().includes(targetName) && 
                               this.characterStates[otherId].isPresent) {
                                this.characterStates[id].interactingWith = this.characters[otherId].name;
                                this.characterStates[id].lastAction = `${action} ${this.characters[otherId].name}`;
                            }
                        });
                    }
                });
                
                // Check for emotional states
                emotionalStatePatterns.forEach(pattern => {
                    const emRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    if (contextContent.match(emRegex)) {
                        const emotion = pattern.source.replace(/\\b|\(|\)|\/i/g, '').split('|')[0];
                        this.characterStates[id].emotionalState = emotion;
                    }
                });
                
                // Check if character is mentioned as leaving
                leavePatterns.forEach(pattern => {
                    const leaveRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    if (contextContent.match(leaveRegex)) {
                        const matches = contextContent.match(leaveRegex);
                        
                        // Reset interaction state when leaving
                        this.characterStates[id] = {
                            ...this.characterStates[id],
                            isPresent: false,
                            lastSeen: now,
                            interactingWith: undefined,
                            lastAction: 'left the scene'
                        };
                        
                        // Try to extract where they went
                        if (matches && matches[1]) {
                            this.characterStates[id].currentActivity = `went to ${matches[1]}`;
                            this.characterStates[id].location = matches[1];
                        } else {
                            this.characterStates[id].currentActivity = 'away';
                        }
                    }
                });
                
                // Check for returning characters
                returnPatterns.forEach(pattern => {
                    const returnRegex = new RegExp(`\\b${charName}\\b.{0,30}${pattern.source}`, 'i');
                    if (contextContent.match(returnRegex)) {
                        this.characterStates[id] = {
                            ...this.characterStates[id],
                            isPresent: true,
                            currentActivity: 'conversing',
                            location: 'main area',
                            lastSeen: now
                        };
                        
                        // Если задача была временной, удаляем таймер
                        if (this.taskTimers[id]) {
                            delete this.taskTimers[id];
                        }
                    }
                });
                
                // Check for private conversations
                privatePatterns.forEach(pattern => {
                    const privateMatch = contextContent.match(pattern);
                    if (privateMatch) {
                        // Make most characters temporarily absent for private conversation
                        availableChars.forEach(otherId => {
                            const otherCharName = this.characters[otherId].name.toLowerCase();
                            // If character is not mentioned in private conversation, mark as absent
                            if (!contextContent.toLowerCase().includes(otherCharName)) {
                                this.characterStates[otherId] = {
                                    ...this.characterStates[otherId],
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
        });
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

        // Create detailed character descriptions with physical states
        const characterDescriptions = activeChars
            .map(id => {
                const char = this.characters[id];
                const state = this.characterStates[id];
                let description = `${char.name}:\n`;
                
                // Only include the description field as requested
                if (char.description) {
                    description += `${char.description}`;
                }
                
                // Add physical state information if available
                if (state) {
                    const physicalDetails = [];
                    
                    if (state.position) {
                        physicalDetails.push(`Currently ${state.position}`);
                    }
                    
                    if (state.holdingItems && state.holdingItems.length > 0) {
                        physicalDetails.push(`Holding: ${state.holdingItems.join(', ')}`);
                    }
                    
                    if (state.currentActivity && state.currentActivity !== 'conversing') {
                        physicalDetails.push(`Activity: ${state.currentActivity}`);
                    }
                    
                    if (state.emotionalState && state.emotionalState !== 'neutral') {
                        physicalDetails.push(`Mood: ${state.emotionalState}`);
                    }
                    
                    if (state.interactingWith) {
                        physicalDetails.push(`Interacting with: ${state.interactingWith}`);
                    }
                    
                    if (state.lastAction && state.lastAction !== 'conversing') {
                        physicalDetails.push(`Last action: ${state.lastAction}`);
                    }
                    
                    if (physicalDetails.length > 0) {
                        description += ` (${physicalDetails.join(' | ')})`;
                    }
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

        // Create a detailed scene description based on character positions and interactions
        const sceneDescription = activeChars.length > 0 
            ? `Current scene: Characters are in the ${activeChars.length > 0 ? this.characterStates[activeChars[0]].location || 'main area' : 'main area'}. ` +
              activeChars.map(id => {
                  const char = this.characters[id];
                  const state = this.characterStates[id];
                  let desc = `${char.name} is ${state.position || 'present'}`;
                  
                  if (state.currentActivity && state.currentActivity !== 'conversing') {
                      desc += ` and ${state.currentActivity}`;
                  }
                  
                  if (state.holdingItems && state.holdingItems.length > 0) {
                      desc += ` while holding ${state.holdingItems.join(', ')}`;
                  }
                  
                  if (state.interactingWith) {
                      desc += ` and interacting with ${state.interactingWith}`;
                  }
                  
                  return desc;
              }).join('. ') + '.'
            : '';

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

        const stageDirections = `System: YOU MUST CREATE ONE SINGLE UNIFIED NARRATIVE SCENE. DO NOT GENERATE SEPARATE BLOCKS FOR EACH CHARACTER. All characters interact in the same flowing text.

${isFirstMessage ? 'FIRST MESSAGE INSTRUCTIONS:\n' + firstMessageInstructions + '\n\n' : ''}CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${sceneDescription ? 'CURRENT SCENE STATE:\n' + sceneDescription + '\n\n' : ''}${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

${!isFirstMessage ? 'FULL CONVERSATION HISTORY:\n' + fullHistory + '\n\n' : ''}New message from User: "${userMessage.content}"

OUTPUT FORMAT - EXTREMELY IMPORTANT:
- Create a SINGLE FLOWING NARRATIVE with all characters interacting naturally
- DO NOT separate responses by character or create individual blocks
- DO NOT prefix response with "Preview" or character names as headers
- DO NOT return multiple character responses - only ONE combined scene
- ONLY INCLUDE CHARACTERS MARKED AS PRESENT - absent characters must not appear
- Characters ENTER/EXIT scenes naturally - reference where absent characters went
- Characters appear in the scene together, interacting with each other
- Format dialogue as: **Character Name** "What they say" *followed by actions*
- Descriptions of the environment should be in *italics* without character attribution
- For quick exchanges, you can use a more compact format
- The sequence of character appearances should reflect natural conversation flow - begin with whoever would logically respond first based on context

CRITICAL NARRATIVE RULES:
1. DO NOT GENERATE USER RESPONSES OR DIALOGUE. The user speaks for themselves only.
2. CREATE ONE COMBINED NARRATIVE WITH ALL PRESENT CHARACTERS naturally interacting.
3. BEGIN WITH THE MOST CONTEXTUALLY APPROPRIATE CHARACTER OR ACTION based on the current situation.
4. CHARACTERS SHOULD PRIMARILY INTERACT WITH EACH OTHER, not just with the user.
5. REACT IMMEDIATELY to important statements or actions - don't delay reactions.
6. VARY DIALOGUE PACING between detailed descriptions and quick exchanges as appropriate.
7. AVOID ALL REPETITIVE PATTERNS in speech, actions, and story structure.
8. MAINTAIN NARRATIVE CONTINUITY - track which characters are present/absent and their activities.
9. Characters who LEAVE THE SCENE should DISAPPEAR until they logically return.
10. TEMPORARY CHARACTERS should only appear when contextually relevant.
11. LOCATION TRANSITIONS should affect which characters are present and active.
12. DO NOT INVENT NEW CHARACTERS - use only those listed above.
13. The user is an EQUAL CONVERSATION PARTICIPANT, though not physically present.
14. ${isAmbientFocused ? 'FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on the user\'s message.' : 'Balance responding to the user with character interactions.'}
${!isFirstMessage ? '15. REFERENCE PAST CONVERSATIONS when appropriate for continuity.' : '15. ESTABLISH THE INITIAL SCENE and character dynamics in an engaging way.'}
${primaryResponders.length > 0 ? '16. While ALL CHARACTERS should participate, characters who were DIRECTLY ADDRESSED ('+ primaryResponders.map(id => this.characters[id].name).join(", ") +') should respond more directly.' : ''}

DIALOGUE & INTERACTION TECHNIQUES:
- Use VARIED LANGUAGE AND STRUCTURES for each character based on their personality
- Create OVERLAPPING DIALOGUES where characters react mid-sentence and finish each other's thoughts
- Mix QUICK EXCHANGES (e.g., **Character1** "Yes." **Character2** "I know!") with detailed interactions
- Include INTERNAL THOUGHTS and MICRO-REACTIONS throughout (subtle expressions, brief gestures)
- Show characters PHYSICALLY MOVING and ENGAGING WITH ENVIRONMENT during conversation
- CREATE DYNAMIC GROUP INTERACTIONS with side conversations and varying subgroups
- BALANCE emotional intensity - mix serious moments with humor and lightness
- Use ALL SENSES in descriptions - sounds, smells, textures, not just visual elements
- Create NATURAL INTERRUPTIONS, hesitations, and imperfections in dialogue
- Characters should ADDRESS EACH OTHER BY NAME and reference each other's statements
- Include NON-VERBAL COMMUNICATION - body language, expressions, shared looks
- Allow characters to MISUNDERSTAND or DISAGREE with natural passion
- For casual topics, keep dialogue LIGHT AND BRISK with minimal description
- For important moments, use more detailed emotional and sensory descriptions
- Incorporate GROUP REACTIONS to significant events or statements

PHYSICAL CONSISTENCY RULES:
- MAINTAIN SPATIAL AWARENESS - track character positions and distances between them
- RESPECT PHYSICAL LIMITATIONS - actions take time and follow logical sequences
- NO TELEPORTATION - characters must move through space to reach new locations
- MAINTAIN OBJECT PERMANENCE - items characters interact with should remain consistent
- TRACK PHYSICAL STATES like sitting/standing/holding items throughout the scene
- NATURAL SEQUENCES OF MOTION - characters cannot skip intermediate actions
- AVOID REPETITIVE PHYSICAL GESTURES or signature movements for each character
- PROGRESSIVE ACTIONS - if a character starts an action, complete it before starting another
- ACTION CONTINUITY - if a character was doing something, reference its completion or interruption
- RESPECT CURRENT CHARACTER POSITIONS AND ITEMS they are holding when describing actions
- SHOW TRANSITIONAL MOVEMENTS - characters should be shown moving from one position to another
- MAINTAIN CONSISTENCY with the current scene description
- ENSURE PHYSICAL INTERACTIONS are appropriate for character positions and proximities

${absentCharactersInfo.length > 0 ? 'ABSENT CHARACTER RULES:\n- Characters listed as absent MUST NOT appear in the scene - no dialogue, no actions\n- They may be referenced in past tense or as being away\n- Do not suddenly introduce them without a clear return\n\n' : ''}SCENE MANAGEMENT:
- MAINTAIN A COHERENT SENSE OF PLACE throughout the narrative
- Characters should EXIT AND ENTER scenes naturally, not just appear/disappear
- Apply LOGICAL TIMEFRAMES - tasks that would take time in reality should take time in story
- Use the concept of NARRATIVE FOCUS - like a camera, attention can move between characters
- REINTRODUCE returning characters with context about what they were doing
- Characters can FADE TO BACKGROUND and become relevant again as conversation shifts
- Apply ENVIRONMENTAL PERSISTENCE - absent characters can still impact scene through objects/effects
- Characters SHOULD NOT TELEPORT - account for movement between locations
- When the scene SHIFTS FOCUS, characters not involved naturally receive less attention
- Transitions between locations should affect who is present and relevant
- MAINTAIN OBJECT CONTINUITY - track items characters interact with throughout the scene
- HONOR PHYSICS AND DISTANCE - characters can't instantly cross large spaces
- ACTIVITIES TAKE TIME - maintain realistic durations for actions characters perform
- REFERENCE CURRENT CHARACTER STATES such as positions, held items, and current activities
- ENSURE ENVIRONMENTAL CONTEXT is maintained and referred to appropriately

${primaryResponders.length > 0 ? 'DIRECTLY ADDRESSED CHARACTERS:\n- Characters who were directly addressed ('+ primaryResponders.map(id => this.characters[id].name).join(", ") +') should acknowledge the user\'s message\n- They should respond with particular attention to the user\'s statements\n- Other characters can still participate but may react to these characters\' responses\n\n' : ''}MATURE CONTENT GUIDELINES:
- Describe PHYSICAL AND INTIMATE INTERACTIONS with clear, direct language
- Use ANATOMICALLY CORRECT TERMINOLOGY rather than euphemisms
- Show UNIQUE PHYSICAL AND EMOTIONAL RESPONSES from each character
- Include DETAILED SENSORY EXPERIENCES during intimate moments
- MAINTAIN CHARACTER VOICES consistently during intimate scenes
- CREATE NATURAL PROGRESSION of physical interactions
- DO NOT CENSOR descriptions - be straightforward and specific
- ALL CONSENT IS ESTABLISHED through the scenario

RESPONSE FORMAT:
- Use **Character Name** to indicate who is speaking or acting
- Use *italics* for thoughts, actions, and descriptions (e.g., **Character** *walks slowly to the window*)
- Use "quotes" for dialogue (e.g., **Character** "This is what I think about that.")
- Characters can have internal thoughts about what others say (e.g., **Character** *thinks to herself about what Other Character just said*)
- Characters can react to others within the same turn (e.g., **Character** *raises an eyebrow at Other Character's comment* "I'm not sure that's right.")
- Multiple characters can interact in sequence without the user's intervention
- Descriptions of the environment and scene setting should be in *italics* without character attribution
- For quick exchanges, you can use a more compact format (e.g., **Character1** "Yes." **Character2** "I know!" **Character1** "Then why did you ask?")
- The sequence of character appearances should reflect natural conversation flow - begin with whoever would logically respond first based on context
- CONSISTENTLY use this format throughout the entire response

ANTI-REPETITION TECHNIQUES:
- AVOID CHARACTER VERBAL TICS - don't give characters signature phrases they repeat
- VARY REACTIONS - don't have characters always respond the same way to similar situations
- USE SYNONYMS - avoid repeating the same descriptive words for actions
- ALTERNATE ACTION TYPES - mix physical, verbal, emotional, and thought-based responses
- DIVERSIFY INTERACTION PATTERNS - don't fall into predictable back-and-forth exchanges
- TRACK USED DESCRIPTIONS - avoid repeating the same descriptions for character actions
- BALANCE GROUP DYNAMICS - don't always have the same characters interacting
- AVOID FORMULA RESPONSES - vary how characters express agreement, disagreement, etc.
- DIVERSIFY CHARACTER MOVEMENT DESCRIPTIONS - don't use the same pattern for movement
- VARY EMOTIONAL EXPRESSIONS - use different ways to show the same emotion
- USE DIFFERENT SENTENCE STRUCTURES for similar actions
- AVOID OVERUSED ADJECTIVES AND ADVERBS when describing character actions
- MAINTAIN A LIST OF RECENTLY USED ACTION DESCRIPTIONS and avoid repeating them

FINAL REMINDER - EXTREMELY IMPORTANT:
- DO NOT generate separate character blocks or "Preview" sections
- ALL characters must appear in ONE UNIFIED NARRATIVE
- Your response must be a SINGLE FLOWING SCENE with natural interactions
- The response should flow naturally with characters interacting with each other
- NEVER make the user speak or act - they are not a character in your response
- DO NOT invent new characters not listed above
- MAINTAIN CONSISTENT FORMATTING throughout`;

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
        
        // Extract the generated response content
        const content = botMessage.content;
        
        // Check if the response follows the expected unified narrative format
        // Look for signs of separate character blocks or "Preview" sections
        let modifiedContent = content;
        
        // Remove any "Preview" headers
        modifiedContent = modifiedContent.replace(/^Preview\s*$/gim, '');
        
        // Remove character name blocks (name alone on a line)
        modifiedContent = modifiedContent.replace(/^([A-Za-z]+)\s*$/gim, '');
        
        // If we still have multiple character blocks, try to convert them to a unified format
        if (/^([A-Za-z]+)\n.*?\n\n([A-Za-z]+)\n/gms.test(modifiedContent)) {
            // Split by empty lines and process
            const blocks = modifiedContent.split(/\n\n+/);
            const processedBlocks = blocks.map((block: string) => {
                // Check if this looks like a character block
                const lines = block.split('\n');
                if (lines.length > 1 && /^[A-Za-z]+$/.test(lines[0].trim())) {
                    const character = lines[0].trim();
                    const content = lines.slice(1).join('\n');
                    // Convert to unified format with character name in bold
                    return `**${character}** ${content}`;
                }
                return block;
            });
            modifiedContent = processedBlocks.join('\n\n');
        }
        
        // Store the response in history
        // Используем всех активных персонажей, а не только отвечающих
        const activeChars = this.getActiveCharacters();
        
        // Add to response history
        const responseEntry: ChatStateType['responseHistory'][0] = {
            responders: activeChars,
            messageContent: modifiedContent, // Use potentially modified content
            timestamp: Date.now()
        };
        
        this.responseHistory = [
            ...this.responseHistory,
            responseEntry
        ];
        
        // Final check to ensure we don't have any remaining "Preview" artifacts
        if (/preview/i.test(modifiedContent)) {
            console.warn("Response still contains 'Preview' sections after processing");
        }
        
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

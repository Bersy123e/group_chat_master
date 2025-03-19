import { Message } from './types';
import { CharacterManager } from './CharacterManager';
import * as Directions from '../constants/SceneDirections';

/**
 * Scene Direction Builder class
 * Composes separate instruction modules into a unified text for LLM
 */
export class SceneDirectionBuilder {
    private characterManager: CharacterManager;
    
    constructor(characterManager: CharacterManager) {
        this.characterManager = characterManager;
    }
    
    /**
     * Builds full scene instructions based on current state
     */
    public buildStageDirections(
        userMessage: Message,
        isFirstMessage: boolean,
        fullHistory: string = '',
        primaryResponders: string[] = []
    ): string {
        // Get character descriptions
        const characterDescriptions = this.characterManager.createCharacterDescriptions();
        
        // Get scene description
        const sceneDescription = this.characterManager.createSceneDescription();
        
        // Get information about absent characters
        const absentCharactersInfo = this.characterManager.getAbsentCharactersInfo();
        
        // Determine if the scene should be more ambient-focused
        // If the user message is short or a greeting, focus on world description
        const isAmbientFocused = 
            userMessage.content.length < 15 || 
            /^(hi|hello|hey|greetings|sup|yo|what's up|how are you)/i.test(userMessage.content);
        
        // Create text with primary characters addressed
        const primaryFocusText = primaryResponders.length > 0 ? 
            `CHARACTERS DIRECTLY ADDRESSED: ${primaryResponders.map(id => 
                this.characterManager.getCharacter(id)?.name || '').join(", ")}` : '';
                
        // Special instructions for first message
        const firstMessageInstructions = isFirstMessage ? 
            `This is the FIRST MESSAGE in the conversation. Start by introducing the scene and characters naturally. Establish the setting and initial dynamics between characters. Respond to the user's first message in a way that welcomes them to the conversation.` : '';
        
        // Character relationships - derived from history
        const characterRelationships = `The characters have a shared history and ongoing relationships based on their previous interactions. They should reference past conversations and events when appropriate, building on established dynamics.`;
    
        // Determine narrative style based on user message
        const narrativeStyle = this.determineNarrativeStyle(userMessage.content);
        
        // Add user-focused reminder based on message content
        const userFocusReminder = `
USER ENGAGEMENT REMINDER:
- {{user}}'s message: "${userMessage.content}"
- FIRST have characters directly respond to this message
- ENSURE multiple characters engage with {{user}}'s input
- BALANCE responding to {{user}} with character-to-character interaction
- END the scene with a character addressing {{user}} directly
`;

        // Add a specific section to prevent assumptions about user actions
        const userActionRestriction = `
USER ACTION RESTRICTION - EXTREMELY IMPORTANT:
- {{user}} IS present in the scene, but NEVER create dialogue or actions FOR {{user}}
- NEVER use phrases like "you reach out", "you look", "you feel", etc. that describe user actions
- NEVER tell {{user}} what they are doing, feeling, or experiencing
- NEVER direct the user with phrases like "you should" or "you need to"
- NEVER put words in {{user}}'s mouth or assume their intentions
- Characters should ONLY respond to what {{user}} has EXPLICITLY stated in their message
- Characters MUST treat {{user}} as a participant who controls their OWN actions
- Characters CAN interact with {{user}} through dialogue and actions, but NEVER control {{user}}'s responses
- Treat {{user}} as someone who makes their OWN choices and takes their OWN actions
- ONLY {{user}} decides what they do, say, or feel - NEVER the LLM
`;

        // Add explicit cross-response repetition prevention
        const antiRepetitionGuidance = `
CROSS-RESPONSE REPETITION PREVENTION:
- GENERATE COMPLETELY NEW CONTENT for this response
- DO NOT repeat content from previous responses
- DO NOT continue previous narrative exactly where it left off
- CREATE NEW DIALOGUE, NEW ACTIONS, and NEW NARRATIVE elements
- DO NOT reuse the same scene setting or atmosphere as before
- AVOID repeating any significant phrases or exchanges from earlier responses
- NEVER repeat the beginning of a previous response (even partially)
- EACH RESPONSE MUST BE FRESH, UNIQUE, and STANDALONE (while maintaining continuity)
- IF you feel like you're repeating something from before, CHANGE IT COMPLETELY
`;

        // Build full scene instructions
        return `System: YOU MUST CREATE ONE SINGLE IMMERSIVE NARRATIVE SCENE WHERE ALL CHARACTERS INTERACT TOGETHER. Begin with a brief scene setting, then have characters directly respond to {{user}}'s message, followed by natural interactions among all present characters. DO NOT GENERATE SEPARATE BLOCKS FOR EACH CHARACTER. All characters interact in the same flowing text.

CRITICAL USER RULE - {{user}} IS A PARTICIPANT IN THE SCENE BUT YOU MUST NEVER GENERATE ACTIONS OR DIALOGUE FOR {{user}}. {{user}} controls their own actions and words through their messages. Characters must acknowledge and respond to {{user}}'s message.

${isFirstMessage ? 'FIRST MESSAGE INSTRUCTIONS:\n' + firstMessageInstructions + '\n\n' : ''}CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${sceneDescription ? 'CURRENT SCENE STATE:\n' + sceneDescription + '\n\n' : ''}${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

${userFocusReminder}

${userActionRestriction}

${antiRepetitionGuidance}

NARRATIVE STYLE:
${narrativeStyle}

${!isFirstMessage ? 'FULL CONVERSATION HISTORY:\n' + fullHistory + '\n\n' : ''}New message from {{user}}: "${userMessage.content}"

OUTPUT FORMAT - EXTREMELY IMPORTANT:
${Directions.OUTPUT_FORMAT}

DO NOT deviate from this format. DO NOT include any {{user}} dialogue or actions in your response. NEVER copy or repeat the beginning of previous responses.

CRITICAL NARRATIVE RULES:
${Directions.NARRATIVE_RULES}
${isAmbientFocused ? '16. FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on {{user}}\'s message.' : '16. Balance responding to {{user}} with character interactions.'}
${!isFirstMessage ? '17. REFERENCE PAST CONVERSATIONS when appropriate for continuity.' : '17. ESTABLISH THE INITIAL SCENE and character dynamics in an engaging way.'}
${primaryResponders.length > 0 ? '18. While ALL CHARACTERS should participate, characters who were DIRECTLY ADDRESSED ('+ primaryResponders.map(id => this.characterManager.getCharacter(id)?.name || '').join(", ") +') should INITIATE the response, but NOT be the only ones responding.' : ''}
19. NEVER COPY OR PARTIALLY COPY THE START OF A PREVIOUS RESPONSE - each response must begin fresh.

DIALOGUE & INTERACTION TECHNIQUES:
${Directions.DIALOGUE_TECHNIQUES}

PHYSICAL CONSISTENCY RULES:
${Directions.PHYSICAL_CONSISTENCY}

${absentCharactersInfo.length > 0 ? 'ABSENT CHARACTER RULES:\n' + Directions.ABSENT_CHARACTER_RULES + '\n\n' : ''}SCENE MANAGEMENT:
${Directions.SCENE_MANAGEMENT}

USER REPRESENTATION RULES:
${Directions.USER_REPRESENTATION}

${primaryResponders.length > 0 ? 'DIRECTLY ADDRESSED CHARACTERS:\n' + Directions.DIRECTLY_ADDRESSED_RULES + '\n\n' : ''}MATURE CONTENT GUIDELINES:
${Directions.MATURE_CONTENT_GUIDELINES}

${primaryResponders.length > 0 ? 'DIRECTLY ADDRESSED CHARACTERS:\n' + Directions.DIRECTLY_ADDRESSED_RULES + '\n\n' : ''}MATURE CONTENT GUIDELINES - EXPLICIT CLARITY REQUIRED:
${Directions.EXPLICIT_MATURE_CONTENT}

RESPONSE FORMAT:
${Directions.RESPONSE_FORMAT}

ANTI-REPETITION TECHNIQUES:
${Directions.ANTI_REPETITION}

ADVANCED DIALOGUE VARIATION - EXTREMELY IMPORTANT:
${Directions.ADVANCED_DIALOGUE_VARIATION}

SCENE DYNAMIC VARIATION:
${Directions.SCENE_DYNAMIC_VARIATION}

FINAL REMINDER - EXTREMELY IMPORTANT:
${Directions.FINAL_REMINDER}
${absentCharactersInfo.length > 0 ? `\n- ABSOLUTELY DO NOT INCLUDE ABSENT CHARACTERS: ${absentCharactersInfo.join(', ')}\n- Characters who are absent CANNOT speak, act, or appear until they explicitly return` : ''}
- NEVER COPY OR PARTIALLY COPY THE START OF PREVIOUS RESPONSES - begin completely fresh!`;
    }
    
    /**
     * Determines the appropriate narrative style based on user message
     */
    private determineNarrativeStyle(message: string): string {
        // Check for emotional content that might influence the narrative style
        const hasEmotionalContent = /(\bsad\b|\bangry\b|\bhappy\b|\bexcited\b|\bafraid\b|\bscared\b|\blove\b|\bhate\b|\bfeel|\bfeeling|\bemotion)/i.test(message);
        const hasActionContent = /(\brun\b|\bjump\b|\bfight\b|\bmove\b|\battack\b|\bdefend\b|\bprotect\b|\bwalk|\bstand|\btouch|\bhold|\bgrab|\bpush|\bpull)/i.test(message);
        const hasMysteryContent = /(\bmystery\b|\bsecret\b|\bclue\b|\binvestigate\b|\bunknown\b|\bhidden\b|\bpuzzle|\bwonder|\bcurious|\bstrange|\bodd|\bweird)/i.test(message);
        const hasQuestionContent = /(\?|what|how|why|when|where|who|which|whose|whom|can|could|would|will|should)/i.test(message);
        
        let style = `
- Create a vivid, flowing narrative with meaningful descriptions
- Balance dialogue with environmental and character descriptions
- Include small but meaningful details about the scene and characters
- Show internal character thoughts and reactions
- Use varied pacing appropriate to the mood
- Create a natural story progression within each response
- EXPLICITLY RESPOND TO {{user}}'s message before additional character interactions
- ENSURE each character has a UNIQUE way of expressing themselves
- AVOID REPEATING the same words, phrases, or actions throughout the response
- CREATE A FRESH AND NEW SCENE each time - do not repeat previous scenes or scenarios
- START FRESH with a new narrative approach for EACH response
`;

        // Add specific focus based on message content
        if (hasEmotionalContent) {
            style += `
- EMPHASIZE EMOTIONAL RESONANCE in this scene
- Focus on character feelings, expressions, and emotional reactions
- Use evocative language that conveys emotional depth
- Show how emotions affect character interactions and decisions
- Have characters DIRECTLY ACKNOWLEDGE the emotional content of {{user}}'s message
- Show DISTINCT EMOTIONAL REACTIONS from each character based on their personality
`;
        }
        
        if (hasActionContent) {
            style += `
- EMPHASIZE DYNAMIC ACTION in this scene
- Create vivid, cinematic descriptions of movement and physical activity
- Use strong verbs and sensory details to make actions feel immediate
- Balance quick, tense actions with character reactions
- Show how characters PHYSICALLY RESPOND to {{user}}'s message
- Each character should display UNIQUE physical mannerisms and movements
`;
        }
        
        if (hasMysteryContent) {
            style += `
- EMPHASIZE ATMOSPHERE AND INTRIGUE in this scene
- Create an air of mystery with subtle environmental details
- Include character observations that hint at hidden meanings
- Balance revealing information with maintaining curiosity
- Show characters actively working to understand {{user}}'s mysterious message
- Each character should show DIFFERENT LEVELS of curiosity or suspicion
`;
        }
        
        if (hasQuestionContent) {
            style += `
- DIRECTLY ANSWER {{user}}'s question through character dialogue
- Show different characters offering DIFFERENT PERSPECTIVES on the answer
- Create a natural discussion about {{user}}'s question
- Ensure EVERY character acknowledges or contributes to answering the question
- End the scene with a follow-up question to {{user}} that builds on the discussion
`;
        }
        
        // If no specific style detected, add general storytelling guidance
        if (!hasEmotionalContent && !hasActionContent && !hasMysteryContent && !hasQuestionContent) {
            style += `
- FOCUS ON NATURAL CONVERSATION FLOW with meaningful context
- Create a balanced mix of dialogue and environmental details
- Show subtle character interactions and non-verbal communication
- Maintain a coherent narrative thread throughout the response
- FIRST have characters respond directly to {{user}}'s message
- ENSURE characters reference {{user}} by name in dialogue
- Create UNIQUE personality expressions for each character
`;
        }
        
        // Add anti-repetition reminders
        style += `
ANTI-REPETITION GUIDANCE:
- DO NOT REUSE verbs, adjectives, or adverbs within the response
- VARY character actions - no character should perform the same action twice
- USE DIFFERENT body language and facial expressions for each emotion
- CREATE UNIQUE speech patterns and word choices for each character
- DIVERSIFY interaction patterns between characters
- ALTERNATE between dialogue, action, thought, and environment descriptions
- TRACK word usage and avoid repeating significant words
`;

        return style;
    }
} 
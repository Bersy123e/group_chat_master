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
USER ACTION RESTRICTION:
- NEVER assume any user actions or put words in user's mouth
- NEVER use "you" statements or narrate FROM user's perspective
- NEVER tell the user what they should do, feel, or experience
- Characters can talk TO user but never FOR user
- ONLY respond to what user has EXPLICITLY stated in their message
`;

        // Add explicit cross-response repetition prevention
        const antiRepetitionGuidance = `
ANTI-REPETITION GUIDANCE:
- Generate completely new content for each response
- Do not repeat previous descriptions or dialogue
- Create fresh scene settings and atmosphere
- Vary character actions and reactions
- Use different words and phrases throughout
`;

        // Build full scene instructions
        return `CHARACTERS IN SCENE:
${characterDescriptions}

${sceneDescription ? 'CURRENT SCENE STATE:\n' + sceneDescription + '\n\n' : ''}${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `ABSENT: ${absentCharactersInfo.join(', ')}` : ''}

USER MESSAGE: "${userMessage.content}"

${userActionRestriction}

OUTPUT REQUIREMENTS:
1. Track scene state and character positions internally using the JSON structure below
2. Display response in natural narrative format
3. Never generate user actions or dialogue
4. Ensure all characters participate naturally
5. End with character engaging the user

${Directions.STRUCTURED_OUTPUT_FORMAT}

${Directions.USER_REPRESENTATION}

${Directions.FINAL_REMINDER}`;
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
        
        return style;
    }
}
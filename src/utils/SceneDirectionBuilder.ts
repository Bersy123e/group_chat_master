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
        
        // Build full scene instructions
        return `System: YOU MUST CREATE ONE SINGLE IMMERSIVE NARRATIVE SCENE WHERE ALL CHARACTERS INTERACT TOGETHER. Begin with a brief scene setting, then have the most contextually appropriate character respond first, followed by natural interactions with all other present characters. DO NOT GENERATE SEPARATE BLOCKS FOR EACH CHARACTER. All characters interact in the same flowing text.

CRITICAL USER RULE - {{user}} IS NEVER A CHARACTER IN YOUR NARRATIVE. NEVER GENERATE RESPONSES FOR {{user}}. {{user}} exists outside the narrative and only sends input messages.

${isFirstMessage ? 'FIRST MESSAGE INSTRUCTIONS:\n' + firstMessageInstructions + '\n\n' : ''}CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${sceneDescription ? 'CURRENT SCENE STATE:\n' + sceneDescription + '\n\n' : ''}${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

NARRATIVE STYLE:
${narrativeStyle}

${!isFirstMessage ? 'FULL CONVERSATION HISTORY:\n' + fullHistory + '\n\n' : ''}New message from {{user}}: "${userMessage.content}"

OUTPUT FORMAT - EXTREMELY IMPORTANT:
${Directions.OUTPUT_FORMAT}

DO NOT deviate from this format. DO NOT include any {{user}} dialogue or actions in your response.

CRITICAL NARRATIVE RULES:
${Directions.NARRATIVE_RULES}
14. ${isAmbientFocused ? 'FOCUS ON THE WORLD AND CHARACTER INTERACTIONS more than on {{user}}\'s message.' : 'Balance responding to {{user}} with character interactions.'}
${!isFirstMessage ? '15. REFERENCE PAST CONVERSATIONS when appropriate for continuity.' : '15. ESTABLISH THE INITIAL SCENE and character dynamics in an engaging way.'}
${primaryResponders.length > 0 ? '16. While ALL CHARACTERS should participate, characters who were DIRECTLY ADDRESSED ('+ primaryResponders.map(id => this.characterManager.getCharacter(id)?.name || '').join(", ") +') should INITIATE the response, but NOT be the only ones responding.' : ''}

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
${absentCharactersInfo.length > 0 ? `\n- ABSOLUTELY DO NOT INCLUDE ABSENT CHARACTERS: ${absentCharactersInfo.join(', ')}\n- Characters who are absent CANNOT speak, act, or appear until they explicitly return` : ''}`;
    }
    
    /**
     * Determines the appropriate narrative style based on user message
     */
    private determineNarrativeStyle(message: string): string {
        // Check for emotional content that might influence the narrative style
        const hasEmotionalContent = /(\bsad\b|\bangry\b|\bhappy\b|\bexcited\b|\bafraid\b|\bscared\b|\blove\b|\bhate\b)/i.test(message);
        const hasActionContent = /(\brun\b|\bjump\b|\bfight\b|\bmove\b|\battack\b|\bdefend\b|\bprotect\b)/i.test(message);
        const hasMysteryContent = /(\bmystery\b|\bsecret\b|\bclue\b|\binvestigate\b|\bunknown\b|\bhidden\b)/i.test(message);
        
        let style = `
- Create a vivid, flowing narrative with meaningful descriptions
- Balance dialogue with environmental and character descriptions
- Include small but meaningful details about the scene and characters
- Show internal character thoughts and reactions
- Use varied pacing appropriate to the mood
- Create a natural story progression within each response
`;

        if (hasEmotionalContent) {
            style += `
- EMPHASIZE EMOTIONAL RESONANCE in this scene
- Focus on character feelings, expressions, and emotional reactions
- Use evocative language that conveys emotional depth
- Show how emotions affect character interactions and decisions
`;
        }
        
        if (hasActionContent) {
            style += `
- EMPHASIZE DYNAMIC ACTION in this scene
- Create vivid, cinematic descriptions of movement and physical activity
- Use strong verbs and sensory details to make actions feel immediate
- Balance quick, tense actions with character reactions
`;
        }
        
        if (hasMysteryContent) {
            style += `
- EMPHASIZE ATMOSPHERE AND INTRIGUE in this scene
- Create an air of mystery with subtle environmental details
- Include character observations that hint at hidden meanings
- Balance revealing information with maintaining curiosity
`;
        }
        
        // If no specific style detected, add general storytelling guidance
        if (!hasEmotionalContent && !hasActionContent && !hasMysteryContent) {
            style += `
- FOCUS ON NATURAL CONVERSATION FLOW with meaningful context
- Create a balanced mix of dialogue and environmental details
- Show subtle character interactions and non-verbal communication
- Maintain a coherent narrative thread throughout the response
`;
        }
        
        return style;
    }
} 
import { Message } from './types';
import { CharacterManager } from './CharacterManager';
import * as Directions from '../constants/SceneDirections';

/**
 * Класс для сборки инструкций сцены
 * Компонует отдельные модули инструкций в единый текст для LLM
 */
export class SceneDirectionBuilder {
    private characterManager: CharacterManager;
    
    constructor(characterManager: CharacterManager) {
        this.characterManager = characterManager;
    }
    
    /**
     * Строит полные инструкции для сцены на основе текущего состояния
     */
    public buildStageDirections(
        userMessage: Message,
        isFirstMessage: boolean,
        fullHistory: string = '',
        primaryResponders: string[] = []
    ): string {
        // Получаем описания персонажей
        const characterDescriptions = this.characterManager.createCharacterDescriptions();
        
        // Получаем описание сцены
        const sceneDescription = this.characterManager.createSceneDescription();
        
        // Получаем информацию об отсутствующих персонажах
        const absentCharactersInfo = this.characterManager.getAbsentCharactersInfo();
        
        // Определяем, должна ли быть сцена более ориентирована на окружение
        // Если сообщение пользователя короткое или приветствие, фокусируемся на описании мира
        const isAmbientFocused = 
            userMessage.content.length < 15 || 
            /^(hi|hello|hey|greetings|sup|yo|what's up|how are you)/i.test(userMessage.content);
        
        // Создаем текст с указанием основных персонажей, к которым направлено сообщение
        const primaryFocusText = primaryResponders.length > 0 ? 
            `CHARACTERS DIRECTLY ADDRESSED: ${primaryResponders.map(id => 
                this.characterManager.getCharacter(id)?.name || '').join(", ")}` : '';
                
        // Специальные инструкции для первого сообщения
        const firstMessageInstructions = isFirstMessage ? 
            `This is the FIRST MESSAGE in the conversation. Start by introducing the scene and characters naturally. Establish the setting and initial dynamics between characters. Respond to the user's first message in a way that welcomes them to the conversation.` : '';
        
        // Отношения персонажей - выводятся из истории
        const characterRelationships = `The characters have a shared history and ongoing relationships based on their previous interactions. They should reference past conversations and events when appropriate, building on established dynamics.`;
    
        // Собираем все инструкции в один текст
        return `System: YOU MUST CREATE ONE SINGLE UNIFIED NARRATIVE SCENE WHERE ALL CHARACTERS INTERACT TOGETHER. Begin with the most contextually appropriate character responding first, then INCLUDE all other present characters in the same flowing response. DO NOT GENERATE SEPARATE BLOCKS FOR EACH CHARACTER. All characters interact in the same flowing text.

CRITICAL USER RULE - {{user}} IS NEVER A CHARACTER IN YOUR NARRATIVE. NEVER GENERATE RESPONSES FOR {{user}}. {{user}} exists outside the narrative and only sends input messages.

${isFirstMessage ? 'FIRST MESSAGE INSTRUCTIONS:\n' + firstMessageInstructions + '\n\n' : ''}CHARACTERS IN THE SCENE (ONLY USE THESE EXACT CHARACTERS, DO NOT INVENT NEW ONES):
${characterDescriptions}

${sceneDescription ? 'CURRENT SCENE STATE:\n' + sceneDescription + '\n\n' : ''}${primaryFocusText ? primaryFocusText + '\n\n' : ''}${absentCharactersInfo.length > 0 ? `CHARACTERS NOT PRESENT (STRICTLY DO NOT INCLUDE THESE IN DIALOGUE OR ACTIONS): ${absentCharactersInfo.join(', ')}` : ''}

CHARACTER RELATIONSHIPS:
${characterRelationships}

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
} 
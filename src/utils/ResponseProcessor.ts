import { Message } from './types';
import { CharacterManager } from './CharacterManager';

/**
 * Класс для обработки ответов модели
 * Отвечает за анализ, валидацию и модификацию ответов LLM
 */
export class ResponseProcessor {
    private characterManager: CharacterManager;
    
    // Предкомпилированные регулярные выражения для оптимизации
    private static readonly PREVIEW_PATTERN = /^Preview\s*$/gim;
    private static readonly CHARACTER_BLOCK_PATTERN = /^([A-Za-z]+)\s*$/gim;
    private static readonly MULTIPLE_BLOCKS_PATTERN = /^([A-Za-z]+)\n.*?\n\n([A-Za-z]+)\n/gms;
    
    constructor(characterManager: CharacterManager) {
        this.characterManager = characterManager;
    }
    
    /**
     * Обрабатывает ответ модели, исправляя форматирование и проверяя на отсутствующих персонажей
     */
    public processResponse(content: string): { 
        modifiedContent: string; 
        foundAbsentChars: boolean;
        foundFormatErrors: boolean;
    } {
        let modifiedContent = content;
        let foundAbsentChars = false;
        let foundFormatErrors = false;
        
        // Удаляем "Preview" заголовки
        if (ResponseProcessor.PREVIEW_PATTERN.test(modifiedContent)) {
            modifiedContent = modifiedContent.replace(ResponseProcessor.PREVIEW_PATTERN, '');
            foundFormatErrors = true;
        }
        
        // Удаляем блоки с именами персонажей (имя в отдельной строке)
        if (ResponseProcessor.CHARACTER_BLOCK_PATTERN.test(modifiedContent)) {
            modifiedContent = modifiedContent.replace(ResponseProcessor.CHARACTER_BLOCK_PATTERN, '');
            foundFormatErrors = true;
        }
        
        // Если все еще есть несколько блоков персонажей, преобразуем их в единый формат
        if (ResponseProcessor.MULTIPLE_BLOCKS_PATTERN.test(modifiedContent)) {
            // Разделяем по пустым строкам и обрабатываем
            const blocks = modifiedContent.split(/\n\n+/);
            const processedBlocks = blocks.map((block: string) => {
                // Проверяем, похоже ли это на блок персонажа
                const lines = block.split('\n');
                if (lines.length > 1 && /^[A-Za-z]+$/.test(lines[0].trim())) {
                    const character = lines[0].trim();
                    const content = lines.slice(1).join('\n');
                    // Преобразуем в единый формат с именем персонажа выделенным жирным
                    return `**${character}** ${content}`;
                }
                return block;
            });
            modifiedContent = processedBlocks.join('\n\n');
            foundFormatErrors = true;
        }
        
        // Проверка на отсутствующих персонажей
        const absentChars = this.characterManager.getAbsentCharactersInfo();
        
        if (absentChars.length > 0) {
            // Для каждого отсутствующего персонажа проверяем, есть ли он в ответе
            const absentCharIds = this.characterManager.getAvailableCharacters()
                .filter(id => !this.characterManager.getActiveCharacters().includes(id));
                
            absentCharIds.forEach(id => {
                const charName = this.characterManager.getCharacter(id)?.name || '';
                if (!charName) return;
                
                // Ищем паттерны диалога или действий отсутствующего персонажа
                const dialogPattern = new RegExp(`\\*\\*${charName}\\*\\*\\s*["']`);
                const actionPattern = new RegExp(`\\*\\*${charName}\\*\\*\\s*\\*`);
                
                if (dialogPattern.test(modifiedContent) || actionPattern.test(modifiedContent)) {
                    foundAbsentChars = true;
                    console.warn(`Absent character ${charName} was incorrectly included in the response`);
                }
            });
            
            // Если обнаружены отсутствующие персонажи, добавляем примечание
            if (foundAbsentChars) {
                modifiedContent += "\n\n*Note: Some absent characters were incorrectly included in this scene.*";
            }
        }
        
        // Финальная проверка на "Preview" артефакты
        if (/preview/i.test(modifiedContent)) {
            console.warn("Response still contains 'Preview' sections after processing");
            foundFormatErrors = true;
        }
        
        return {
            modifiedContent,
            foundAbsentChars,
            foundFormatErrors
        };
    }
} 
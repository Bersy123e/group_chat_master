import { Message } from './types';
import { CharacterManager } from './CharacterManager';

/**
 * Response processor class
 * Responsible for analyzing, validating and modifying LLM responses
 */
export class ResponseProcessor {
    private characterManager: CharacterManager;
    
    // Pre-compiled regular expressions for optimization
    private static readonly PREVIEW_PATTERN = /^Preview\s*$/gim;
    private static readonly CHARACTER_BLOCK_PATTERN = /^([A-Za-z]+)\s*$/gim;
    private static readonly MULTIPLE_BLOCKS_PATTERN = /^([A-Za-z]+)\n.*?\n\n([A-Za-z]+)\n/gms;
    
    constructor(characterManager: CharacterManager) {
        this.characterManager = characterManager;
    }
    
    /**
     * Processes the model's response, correcting formatting and checking for absent characters
     */
    public processResponse(content: string): { 
        modifiedContent: string; 
        foundAbsentChars: boolean;
        foundFormatErrors: boolean;
    } {
        let modifiedContent = content;
        let foundAbsentChars = false;
        let foundFormatErrors = false;
        
        try {
            console.log('Processing response:', content.substring(0, 100) + '...');
            
            // Check if content is empty or invalid
            if (!content || typeof content !== 'string') {
                console.warn('Received invalid response content:', content);
                return { 
                    modifiedContent: content || '', 
                    foundAbsentChars: false,
                    foundFormatErrors: true
                };
            }
            
            // Remove "Preview" headers
            if (ResponseProcessor.PREVIEW_PATTERN.test(modifiedContent)) {
                modifiedContent = modifiedContent.replace(ResponseProcessor.PREVIEW_PATTERN, '');
                foundFormatErrors = true;
            }
            
            // Remove character blocks (name on separate line)
            if (ResponseProcessor.CHARACTER_BLOCK_PATTERN.test(modifiedContent)) {
                modifiedContent = modifiedContent.replace(ResponseProcessor.CHARACTER_BLOCK_PATTERN, '');
                foundFormatErrors = true;
            }
            
            // If there are still multiple character blocks, convert them to a unified format
            if (ResponseProcessor.MULTIPLE_BLOCKS_PATTERN.test(modifiedContent)) {
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
                foundFormatErrors = true;
            }
            
            // Check for absent characters
            const absentChars = this.characterManager.getAbsentCharactersInfo();
            
            if (absentChars.length > 0) {
                // For each absent character, check if they are in the response
                const absentCharIds = this.characterManager.getAvailableCharacters()
                    .filter(id => !this.characterManager.getActiveCharacters().includes(id));
                    
                absentCharIds.forEach(id => {
                    const charName = this.characterManager.getCharacter(id)?.name || '';
                    if (!charName) return;
                    
                    // Look for dialogue or action patterns from absent character
                    const dialogPattern = new RegExp(`\\*\\*${charName}\\*\\*\\s*["']`);
                    const actionPattern = new RegExp(`\\*\\*${charName}\\*\\*\\s*\\*`);
                    
                    if (dialogPattern.test(modifiedContent) || actionPattern.test(modifiedContent)) {
                        foundAbsentChars = true;
                        console.warn(`Absent character ${charName} was incorrectly included in the response`);
                    }
                });
                
                // If absent characters are detected, add a note
                if (foundAbsentChars) {
                    modifiedContent += "\n\n*Note: Some absent characters were incorrectly included in this scene.*";
                }
            }
            
            // Ensure proper narrative flow by preserving paragraph structure
            modifiedContent = this.ensureNarrativeFlow(modifiedContent);
            
            // Final check for "Preview" artifacts
            if (/preview/i.test(modifiedContent)) {
                console.warn("Response still contains 'Preview' sections after processing");
                foundFormatErrors = true;
            }
            
            return {
                modifiedContent,
                foundAbsentChars,
                foundFormatErrors
            };
        } catch (error) {
            console.error('Error processing response:', error);
            // Return original content in case of processing error
            return { 
                modifiedContent: content, 
                foundAbsentChars: false,
                foundFormatErrors: true
            };
        }
    }
    
    /**
     * Ensures narrative flow is maintained by preserving paragraph structure
     */
    private ensureNarrativeFlow(content: string): string {
        try {
            // Identify narrative paragraphs (those without character names in bold)
            const paragraphs = content.split(/\n\n+/);
            
            // Process each paragraph to ensure it maintains narrative flow
            const processedParagraphs = paragraphs.map(paragraph => {
                if (!paragraph.trim()) return '';
                
                // If this is a narrative paragraph (not starting with a character name), 
                // ensure it's properly formatted
                if (!/^\*\*[A-Za-z\s]+\*\*/.test(paragraph)) {
                    // Ensure narrative paragraphs are in italics if they aren't already
                    if (!paragraph.startsWith('*') && !paragraph.endsWith('*')) {
                        return `*${paragraph}*`;
                    }
                }
                
                return paragraph;
            });
            
            return processedParagraphs.filter(p => p).join('\n\n');
        } catch (error) {
            console.error('Error ensuring narrative flow:', error);
            return content;
        }
    }
} 
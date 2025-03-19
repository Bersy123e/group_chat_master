import { Message } from './types';
import { CharacterManager } from './CharacterManager';

/**
 * Response processor class
 * Responsible for analyzing, validating and modifying LLM responses
 */
export class ResponseProcessor {
    private characterManager: CharacterManager;
    private previousResponses: string[] = []; // Track previous responses to detect repetition
    
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
            
            // First, clean up any LLM-generated message headers that could cause repetition
            modifiedContent = this.removeMessageHeaders(modifiedContent);
            
            // Check for and remove repetition from previous responses
            modifiedContent = this.removeRepetitionFromPreviousResponses(modifiedContent);
            
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
            
            // Check for repetitive patterns and reduce them
            modifiedContent = this.identifyAndReduceRepetition(modifiedContent);
            
            // Ensure proper narrative flow by preserving paragraph structure
            modifiedContent = this.ensureNarrativeFlow(modifiedContent);
            
            // Final check for "Preview" artifacts
            if (/preview/i.test(modifiedContent)) {
                console.warn("Response still contains 'Preview' sections after processing");
                foundFormatErrors = true;
            }
            
            // Store this response for future repetition detection
            this.previousResponses.push(modifiedContent);
            // Keep only the last 5 responses to prevent memory bloat
            if (this.previousResponses.length > 5) {
                this.previousResponses.shift();
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
     * Removes message headers that the LLM might generate (like [Message X - CHARACTERS])
     */
    private removeMessageHeaders(content: string): string {
        // Remove any LLM-generated message headers
        const messageHeaderPattern = /\[Message \d+ - (?:USER|CHARACTERS)\]\n/g;
        return content.replace(messageHeaderPattern, '');
    }
    
    /**
     * Checks for and removes content from the response that repeats from previous responses
     */
    private removeRepetitionFromPreviousResponses(content: string): string {
        if (this.previousResponses.length === 0) return content;
        
        let modifiedContent = content;
        
        // First check for exact repetition of previous responses
        for (const prevResponse of this.previousResponses) {
            if (modifiedContent.includes(prevResponse) && prevResponse.length > 50) {
                console.warn(`Detected exact repetition of previous response (length: ${prevResponse.length})`);
                modifiedContent = modifiedContent.replace(prevResponse, '');
            }
        }
        
        // Check for partial, substantial repetitions
        for (const prevResponse of this.previousResponses) {
            // Get segments of previous response for partial matching (minimum 100 chars)
            const segments = this.getSegments(prevResponse, 100);
            
            for (const segment of segments) {
                if (modifiedContent.includes(segment)) {
                    console.warn(`Detected partial repetition of previous response (segment length: ${segment.length})`);
                    modifiedContent = modifiedContent.replace(segment, '');
                }
            }
        }
        
        // Remove extra whitespace that might result from repetition removal
        modifiedContent = modifiedContent.replace(/\n{3,}/g, '\n\n');
        
        return modifiedContent.trim();
    }
    
    /**
     * Breaks down a text into smaller overlapping segments for repetition detection
     */
    private getSegments(text: string, minLength: number): string[] {
        if (text.length <= minLength) return [text];
        
        const segments: string[] = [];
        
        // Extract paragraphs
        const paragraphs = text.split(/\n\n+/);
        
        // Process as potential segments
        let currentSegment = '';
        
        for (const paragraph of paragraphs) {
            // Skip very short paragraphs
            if (paragraph.length < 20) continue;
            
            // If the paragraph alone is large enough, add it
            if (paragraph.length >= minLength) {
                segments.push(paragraph);
                continue;
            }
            
            // Otherwise, build up segments across paragraphs
            currentSegment += paragraph + '\n\n';
            
            if (currentSegment.length >= minLength) {
                segments.push(currentSegment.trim());
                currentSegment = ''; // Reset for the next segment
            }
        }
        
        // If there's any remaining segment, add it
        if (currentSegment.length > 0) {
            segments.push(currentSegment.trim());
        }
        
        return segments;
    }
    
    /**
     * Ensures narrative flow is maintained by preserving paragraph structure and reducing repetition
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
            
            // Join paragraphs with double newlines for proper spacing
            let processedContent = processedParagraphs.filter(p => p).join('\n\n');
            
            // Ensure proper character name formatting
            processedContent = this.enforceCharacterNameFormatting(processedContent);
            
            return processedContent;
        } catch (error) {
            console.error('Error ensuring narrative flow:', error);
            return content;
        }
    }
    
    /**
     * Enforces proper character name formatting and ensures dialogue is attributed correctly
     */
    private enforceCharacterNameFormatting(content: string): string {
        try {
            // Get list of active character names
            const activeCharIds = this.characterManager.getActiveCharacters();
            const characterNames = activeCharIds.map(id => {
                const character = this.characterManager.getCharacter(id);
                return character ? character.name : '';
            }).filter(name => name);
            
            if (characterNames.length === 0) return content;
            
            let processedContent = content;
            
            // Ensure character names are properly formatted in bold
            characterNames.forEach(name => {
                // Don't replace names that are already formatted correctly
                const nameRegex = new RegExp(`(?<!\\*\\*)${name}(?!\\*\\*)`, 'g');
                processedContent = processedContent.replace(nameRegex, `**${name}**`);
            });
            
            // Ensure dialogue attribution follows proper format
            // Fix: Character Name "dialogue" (missing bold)
            processedContent = processedContent.replace(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\s*:?\s*["']([^"']+)["']/g, (match, name, dialogue) => {
                // Check if name is one of the character names
                if (characterNames.some(charName => charName.toLowerCase() === name.toLowerCase())) {
                    return `**${name}** "${dialogue}"`;
                }
                return match;
            });
            
            return processedContent;
        } catch (error) {
            console.error('Error enforcing character name formatting:', error);
            return content;
        }
    }
    
    /**
     * Identifies and reduces repetitive patterns in the response
     */
    private identifyAndReduceRepetition(content: string): string {
        try {
            let processedContent = content;
            
            // Common repetitive patterns to detect
            const commonPatterns = [
                // Repeated nods
                { pattern: /(\bnods?\b.*){2,}/gi, message: 'Detected repetitive nodding' },
                // Repeated smiles
                { pattern: /(\bsmiles?\b.*){2,}/gi, message: 'Detected repetitive smiling' },
                // Repeated sighs
                { pattern: /(\bsighs?\b.*){2,}/gi, message: 'Detected repetitive sighing' },
                // Repeated looks/glances
                { pattern: /(\b(?:looks?|glances?)\b.*){3,}/gi, message: 'Detected repetitive looking/glancing' },
                // Repeated turns
                { pattern: /(\bturns?\b.*){2,}/gi, message: 'Detected repetitive turning' },
                // Repeated raises eyebrow
                { pattern: /(\braises?\s+(?:an\s+)?eyebrow\b.*){2,}/gi, message: 'Detected repetitive eyebrow raising' },
                // Repeated laughs
                { pattern: /(\b(?:laughs?|chuckles?)\b.*){2,}/gi, message: 'Detected repetitive laughing' }
            ];
            
            // Check for common repetitive patterns
            commonPatterns.forEach(({ pattern, message }) => {
                if (pattern.test(processedContent)) {
                    console.warn(message);
                }
            });
            
            return processedContent;
        } catch (error) {
            console.error('Error identifying repetition:', error);
            return content;
        }
    }
} 
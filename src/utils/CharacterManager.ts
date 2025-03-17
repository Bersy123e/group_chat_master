import { Character } from "./types";

/**
 * Класс для управления персонажами в сцене
 * Отвечает за отслеживание состояния, присутствия и действий персонажей
 */
export class CharacterManager {
    private characters: { [key: string]: Character };
    private characterStates: {
        [key: string]: {
            isPresent: boolean;     // Whether the character is present in the scene
            currentActivity?: string; // What the character is currently doing
            location?: string;      // Where the character currently is
            lastSeen?: number;      // Timestamp when character was last active
            position?: string;      // Physical position in the scene (sitting, standing, etc.)
            holdingItems?: string[]; // Items the character is currently holding
            interactingWith?: string; // Character or object they're interacting with
            lastAction?: string;    // Last physical action performed
            emotionalState?: string; // Current emotional state
        }
    };
    private taskTimers: { [key: string]: { task: string, duration: number, startTime: number } } = {};
    
    // Кэш для оптимизации
    private memoizedActiveChars: {[key: string]: string[]} = {};
    private memoizedAvailableChars: string[] | null = null;
    private lastCharStatesHash: string = '';

    constructor(characters: { [key: string]: Character }, initialStates?: any) {
        this.characters = characters;
        this.characterStates = {};
        
        // Initialize character states if they don't exist
        if (initialStates) {
            this.characterStates = initialStates;
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

    /**
     * Возвращает всех доступных персонажей (не удаленных)
     */
    public getAvailableCharacters(): string[] {
        // Реализуем мемоизацию, так как список доступных персонажей
        // меняется редко, но метод может вызываться часто
        if (this.memoizedAvailableChars === null) {
            this.memoizedAvailableChars = Object.keys(this.characters).filter(id => 
                !this.characters[id].isRemoved
            );
        }
        return [...this.memoizedAvailableChars];
    }

    /**
     * Возвращает активных (присутствующих) персонажей
     */
    public getActiveCharacters(): string[] {
        // Генерируем хэш текущего состояния для проверки изменений
        const statesHash = JSON.stringify(
            Object.keys(this.characterStates).map(id => 
                `${id}-${this.characterStates[id].isPresent}-${!!this.characters[id].isRemoved}`
            )
        );
        
        // Если состояние не изменилось, возвращаем кэшированный результат
        if (this.lastCharStatesHash === statesHash && this.memoizedActiveChars[statesHash]) {
            return [...this.memoizedActiveChars[statesHash]];
        }
        
        // Иначе пересчитываем список активных персонажей
        const activeChars = Object.keys(this.characterStates).filter(id => 
            !this.characters[id].isRemoved && this.characterStates[id].isPresent
        );
        
        // Обновляем кэш и хэш состояния
        this.memoizedActiveChars[statesHash] = activeChars;
        this.lastCharStatesHash = statesHash;
        
        return [...activeChars];
    }

    /**
     * Возвращает всех отсутствующих персонажей с информацией о них
     */
    public getAbsentCharactersInfo(): string[] {
        return this.getAvailableCharacters()
            .filter(id => !this.getActiveCharacters().includes(id))
            .map(id => {
                const char = this.characters[id];
                return `${char.name} (${this.characterStates[id].currentActivity || 'away'} at ${this.characterStates[id].location || 'unknown location'})`;
            });
    }

    /**
     * Обновляет состояния персонажей на основе ответа модели
     */
    public updateCharacterStates(messageContent: string): void {
        const now = Date.now();
        
        // Update last seen for all characters who participated
        Object.keys(this.characterStates).forEach(id => {
            if (this.characterStates[id].isPresent) {
                this.characterStates[id].lastSeen = now;
            }
        });
        
        // Шаблоны для обнаружения действий персонажей
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
        
        // Анализируем текст на наличие действий персонажей
        // Делим текст на блоки действий для отдельных персонажей
        const charBlocks = messageContent.match(/\*\*([^*]+)\*\*[^\n]+/g) || [];
        
        for (const block of charBlocks) {
            // Извлекаем имя персонажа и его действия из блока
            const charNameMatch = block.match(/\*\*([^*]+)\*\*/);
            if (!charNameMatch) continue;
            
            const charName = charNameMatch[1].trim();
            // Найдем ID персонажа по имени
            const charId = Object.keys(this.characters).find(id => 
                this.characters[id].name.toLowerCase() === charName.toLowerCase()
            );
            
            if (!charId) continue; // Если персонаж не найден, пропускаем блок
            
            // Проверяем действия на шаблоны ухода
            for (const pattern of leavePatterns) {
                if (pattern.test(block)) {
                    const locationMatch = block.match(/\b(?:to|towards|for|into)\s+(?:the\s+)?([^,.]+)/i);
                    const location = locationMatch ? locationMatch[1] : 'another location';
                    const activity = block.match(/\b(to\s+\w+|for\s+\w+ing|to\s+get)/i);
                    
                    this.characterStates[charId] = {
                        ...this.characterStates[charId],
                        isPresent: false,
                        currentActivity: activity ? activity[0].replace(/^to\s+/, '') : 'away',
                        location: location,
                        lastSeen: now
                    };
                    
                    // Если обнаружена временная задача, устанавливаем таймер для возвращения
                    if (temporaryTaskPatterns.some(p => p.test(block))) {
                        const taskDuration = Math.floor(Math.random() * 5 + 2) * 60000; // 2-7 минут
                        this.taskTimers[charId] = {
                            task: this.characterStates[charId].currentActivity || 'task',
                            duration: taskDuration,
                            startTime: now
                        };
                    }
                    
                    break;
                }
            }
            
            // Проверяем действия на шаблоны возвращения
            for (const pattern of returnPatterns) {
                if (pattern.test(block)) {
                    this.characterStates[charId] = {
                        ...this.characterStates[charId],
                        isPresent: true,
                        currentActivity: 'conversing',
                        lastSeen: now
                    };
                    
                    // Удаляем таймер задачи, если персонаж вернулся
                    if (this.taskTimers[charId]) {
                        delete this.taskTimers[charId];
                    }
                    
                    break;
                }
            }
            
            // Обновляем позицию персонажа
            for (const pattern of positionPatterns) {
                const match = block.match(pattern);
                if (match) {
                    const position = match[1].toLowerCase();
                    let finalPosition = position;
                    
                    // Преобразуем глагол в состояние
                    if (position === 'sits' || position === 'sat') finalPosition = 'sitting';
                    else if (position === 'stands' || position === 'stood') finalPosition = 'standing';
                    else if (position === 'leans' || position === 'leaned') finalPosition = 'leaning';
                    else if (position === 'lies' || position === 'lay') finalPosition = 'lying';
                    else if (position === 'kneels' || position === 'knelt') finalPosition = 'kneeling';
                    
                    this.characterStates[charId] = {
                        ...this.characterStates[charId],
                        position: finalPosition,
                        lastSeen: now
                    };
                    
                    break;
                }
            }
            
            // Обновляем действия с объектами
            for (const pattern of objectInteractionPatterns) {
                const match = block.match(pattern);
                if (match) {
                    const action = match[1].toLowerCase();
                    
                    // Если персонаж берет предмет, добавляем его в holdingItems
                    if (action.includes('pick') || action.includes('take') || action.includes('hold')) {
                        const itemMatch = match[2];
                        if (itemMatch) {
                            const item = itemMatch.trim();
                            const currentItems = this.characterStates[charId].holdingItems || [];
                            
                            // Добавляем только если такого предмета еще нет в списке
                            if (!currentItems.includes(item)) {
                                this.characterStates[charId] = {
                                    ...this.characterStates[charId],
                                    holdingItems: [...currentItems, item],
                                    lastAction: `took ${item}`,
                                    lastSeen: now
                                };
                            }
                        }
                    }
                    // Если персонаж кладет или бросает предмет, удаляем его из holdingItems
                    else if (action.includes('put') || action.includes('place') || action.includes('drop')) {
                        const itemMatch = match[2];
                        if (itemMatch) {
                            const item = itemMatch.trim();
                            const currentItems = this.characterStates[charId].holdingItems || [];
                            
                            this.characterStates[charId] = {
                                ...this.characterStates[charId],
                                holdingItems: currentItems.filter(i => i !== item),
                                lastAction: `${action} ${item}`,
                                lastSeen: now
                            };
                        }
                    }
                    
                    break;
                }
            }
            
            // Обновляем взаимодействия с другими персонажами
            for (const pattern of characterInteractionPatterns) {
                const match = block.match(pattern);
                if (match) {
                    const action = match[1].toLowerCase();
                    const targetMatch = match[match.length - 1];
                    
                    if (targetMatch) {
                        const target = targetMatch.trim();
                        // Проверяем, является ли цель другим персонажем
                        const targetCharId = Object.keys(this.characters).find(id => 
                            this.characters[id].name.toLowerCase() === target.toLowerCase()
                        );
                        
                        if (targetCharId) {
                            this.characterStates[charId] = {
                                ...this.characterStates[charId],
                                interactingWith: this.characters[targetCharId].name,
                                lastAction: `${action} ${this.characters[targetCharId].name}`,
                                lastSeen: now
                            };
                        }
                    }
                    
                    break;
                }
            }
            
            // Обновляем эмоциональное состояние
            for (const pattern of emotionalStatePatterns) {
                const match = block.match(pattern);
                if (match) {
                    const emotion = match[1].toLowerCase();
                    // Приводим к базовой форме
                    let baseEmotion = emotion;
                    if (emotion.endsWith('ly')) baseEmotion = emotion.substring(0, emotion.length - 2);
                    else if (emotion.endsWith('ed')) baseEmotion = emotion.substring(0, emotion.length - 2);
                    else if (emotion.endsWith('ing')) baseEmotion = emotion.substring(0, emotion.length - 3);
                    
                    this.characterStates[charId] = {
                        ...this.characterStates[charId],
                        emotionalState: baseEmotion,
                        lastSeen: now
                    };
                    
                    break;
                }
            }
        }
        
        // Сбрасываем кэш, так как состояния персонажей изменились
        this.memoizedActiveChars = {};
        this.lastCharStatesHash = '';
        this.memoizedAvailableChars = null;
    }

    /**
     * Возвращает текущие состояния персонажей
     */
    public getCharacterStates() {
        return this.characterStates;
    }

    /**
     * Возвращает информацию о персонаже по ID
     */
    public getCharacter(id: string): Character | undefined {
        return this.characters[id];
    }

    /**
     * Возвращает объект с персонажами
     */
    public getCharacters() {
        return this.characters;
    }
    
    /**
     * Создает подробные описания персонажей с физическими состояниями
     */
    public createCharacterDescriptions(): string {
        const activeChars = this.getActiveCharacters();
        return activeChars
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
    }
    
    /**
     * Создает описание текущей сцены на основе позиций и взаимодействий персонажей
     */
    public createSceneDescription(): string {
        const activeChars = this.getActiveCharacters();
        return activeChars.length > 0 
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
    }
} 
import React, { ReactElement } from "react";
import { StageBase, StageResponse, InitialData, Message, Character } from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";
import { CharacterManager } from "./utils/CharacterManager";
import { SceneDirectionBuilder } from "./utils/SceneDirectionBuilder";
import { ResponseProcessor } from "./utils/ResponseProcessor";
import { MessageStateType, ChatStateType, InitStateType } from "./utils/types";

/**
 * Основной класс Stage, реализующий интерфейс StageBase.
 * Этот класс связывает компоненты системы и управляет жизненным циклом сцены.
 */
export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, undefined> {
    private responseHistory: ChatStateType['responseHistory'] = [];
    private characterManager: CharacterManager;
    private sceneDirectionBuilder: SceneDirectionBuilder;
    private responseProcessor: ResponseProcessor;

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, undefined>) {
        super(data);
        const { characters, chatState, messageState } = data;
        
        this.responseHistory = chatState?.responseHistory || [];
        
        // Инициализируем вспомогательные классы
        this.characterManager = new CharacterManager(characters, messageState?.characterStates);
        this.sceneDirectionBuilder = new SceneDirectionBuilder(this.characterManager);
        this.responseProcessor = new ResponseProcessor(this.characterManager);
    }

    async setState(state: MessageStateType): Promise<void> {
        if (state?.lastResponders) {
            // Добавляем ответы персонажей в историю
            this.responseHistory.push({ 
                responders: state.lastResponders,
                timestamp: Date.now(),
                messageContent: ''
            });
        }
        
        // Обновляем состояния персонажей
        if (state?.characterStates) {
            this.characterManager.setCharacterStates(state.characterStates);
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Используем processMessage для обработки входящего сообщения
        const isFirstMessage = this.responseHistory.length === 0;
        return this.processMessage(userMessage, isFirstMessage);
    }
        
    async processMessage(userMessage: Message, isFirstMessage: boolean): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Extract conversation history with clear delineation between messages
        const fullHistory = this.responseHistory
            .map((entry, index) => {
                // Add a message number for easier tracking and delineation
                if (entry.responders.length === 0) {
                    // User message
                    return `[Message ${index + 1} - USER]\n{{user}}: ${entry.messageContent}`;
                } else {
                    // Bot/character response - add a header to clearly mark it
                    return `[Message ${index + 1} - CHARACTERS]\n${entry.messageContent}`;
                }
            })
            .join('\n\n---\n\n'); // Add clear separators between messages

        // Определяем основных персонажей, к которым обращено сообщение пользователя
        let primaryResponders: string[] = [];
        const activeChars = this.characterManager.getActiveCharacters();
        
        activeChars.forEach(id => {
            const charName = this.characterManager.getCharacter(id)?.name.toLowerCase() || '';
            const messageContentLower = userMessage.content.toLowerCase();
            
            // Если персонаж напрямую упомянут в сообщении
            if (charName && messageContentLower.includes(charName)) {
                primaryResponders.push(id);
            }
        });

        // Строим инструкции сцены
        const stageDirections = this.sceneDirectionBuilder.buildStageDirections(
            userMessage,
            isFirstMessage,
            fullHistory,
            primaryResponders
        );

        // Все активные персонажи должны участвовать в сцене
        let respondingCharacterIds = [...activeChars];

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
                characterStates: this.characterManager.getCharacterStates()
            },
            chatState: {
                responseHistory: this.responseHistory
            }
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Update character states based on the response
        this.characterManager.updateCharacterStates(botMessage.content);
        
        // Process the response
        const { modifiedContent, foundAbsentChars, foundFormatErrors } = 
            this.responseProcessor.processResponse(botMessage.content);
        
        // Add to response history
        const responseEntry: ChatStateType['responseHistory'][0] = {
            responders: this.characterManager.getActiveCharacters(),
            messageContent: modifiedContent, // Use potentially modified content
            timestamp: Date.now()
        };
        
        this.responseHistory = [
            ...this.responseHistory,
            responseEntry
        ];
        
        return {
            messageState: {
                lastResponders: this.characterManager.getActiveCharacters(),
                activeCharacters: new Set(this.characterManager.getActiveCharacters()),
                characterStates: this.characterManager.getCharacterStates()
            },
            chatState: {
                responseHistory: this.responseHistory
            }
        };
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        // Ничего не делаем при загрузке
        return {};
    }

    render(): ReactElement {
        return <></>;
    }
}
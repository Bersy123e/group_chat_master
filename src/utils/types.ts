// Импортируем типы из библиотеки
import { Character, Message } from "@chub-ai/stages-ts";

// Тип для состояния сообщения
export type MessageStateType = {
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

// Тип для инициализации состояния чата
export type InitStateType = null;     // We don't need initialization state

// Тип для состояния чата
export type ChatStateType = {
    responseHistory: {
        responders: string[];  // Character IDs who responded
        messageContent?: string; // Content of the message
        timestamp: number;     // When the message was sent
    }[];
};

// Реэкспортируем используемые типы из библиотеки
export type { Character, Message }; 
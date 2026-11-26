export type DeckButton={id:string;scriptId:string;name:string;image:string};
export type DeckTab={id:string;name:string;buttons:DeckButton[]};
export type DeckConfig={tabs:DeckTab[];size:number};
export const deckKey:string;
export function defaultDeck():DeckConfig;
export function readDeck(storage:Pick<Storage,'getItem'>):DeckConfig;
export function moveButton(buttons:DeckButton[],from:string,to:string):DeckButton[];
export function worldMatches(scriptWorld:string,origin:string,worldId:string):boolean;

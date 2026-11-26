export function repositoryName(value: string): string;
export function filterCatalog<T extends {name:string;description:string;path:string;repo:string;author:string;license:string}>(entries:T[], query:string, repo:string, license:string): T[];
export type ModuleSnapshot = {serverOrigin:string;worldId:string;capturedAt?:string;modules?:{id:string;version:string;active:boolean}[]};
export function dependencyStatus(ids:string[],snapshot:ModuleSnapshot|null,origin:string,worldId:string): {id:string;version:string;status:string}[];

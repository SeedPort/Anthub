
export enum BotType {
    forever = 'forever',
    manual = 'manual',
}

export interface ISourceInfo {
    localVersion: string;
    sourceVersion: string;
    sourceMessage?: string;
}

export interface ICredentialsInfo{
    username: string;
    password: string;
    sshKey: string;
    name: string;
    id?: number;
    mode?: string;
}

export interface IRobot {
    image: {
        name: string,
        version?: string,
        config?: any,
    };
    windowJson?: any;
    updatedAt?: Date;

    identifier?: string;
    source: {
        url: string;
        git?: string,

        branch?: string;
        type?: string;
        credentials?: ICredentialsInfo,

    };
    sourceInfo?: ISourceInfo,

    config: any;
    type: BotType;
    name: string;
    id?: number;
    enabled?: boolean;

}
export declare const NO_SHARING_ENV: Readonly<{ RENOR_SHARING: 'off'; DO_NOT_TRACK: '1' }>;
export declare function applyNoSharing<T extends Record<string, string | undefined>>(env: T): T;
export declare function withNoSharing<T extends Record<string, string | undefined>>(env?: T): T;

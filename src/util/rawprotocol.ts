export const RAW_PROTOCOL = "raw://";

export function stripRawProtocol(path: string): string {
    if (path.startsWith(RAW_PROTOCOL)) {
        return path.substring(RAW_PROTOCOL.length);
    } else {
        return path;
    }
}

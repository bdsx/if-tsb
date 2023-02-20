import { GetStdHandle, STD_OUTPUT_HANDLE, WriteFile } from "./kernel32";

const handle = GetStdHandle(STD_OUTPUT_HANDLE);
WriteFile(handle, "test", 4, null, null);

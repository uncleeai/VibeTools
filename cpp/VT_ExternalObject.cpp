/**
 * VT_ExternalObject.cpp - v12 CS+keyboard (cached)
 * Control Surface (track targeting) with keyboard fallback.
 * Return long + TaggedData result (no char* return = no GC crash).
 * All strings static const in .rdata. ESFreeMem is a no-op.
 */

#include "VT_ExternalObject.h"
#include <windows.h>
#include <cstring>

static HMODULE g_csModule = nullptr;
static VtApiExecuteCommandFunc g_csExec = nullptr;

static const char kTrue[]  = "true";
static const char kFalse[] = "false";
static const char kFuncList[] =
    "ESGetVersion,ESInitialize,ESTerminate,ESFreeMem,doCommand";

typedef int (*VtApiExecuteCommandFunc)(const char* commandID);

static BOOL SendCtrlKey(WORD vk) {
    INPUT inputs[4] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = vk;
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = vk;
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(4, inputs, sizeof(INPUT)) == 4;
}

static HMODULE FindControlSurfaceModule() {
    HMODULE hMod = GetModuleHandleW(L"VT_ControlSurface.acsrf");
    if (hMod) return hMod;
    hMod = GetModuleHandleW(L"VT_ControlSurface");
    if (hMod) return hMod;
    const wchar_t* paths[] = {
        L"VT_ControlSurface.acsrf"
    };
    for (int i = 0; i < 1; i++) {
        hMod = LoadLibraryW(paths[i]);
        if (hMod) return hMod;
    }
    return nullptr;
}

// ── Adobe ExternalObject API ─────────────────────────────
VT_API long ESGetVersion() {
    return (1 << 16) | 0;
}

VT_API const char* ESInitialize(const TaggedData** argv, long argc) {
    g_csModule = FindControlSurfaceModule();
    if (g_csModule) {
        g_csExec = (VtApiExecuteCommandFunc)GetProcAddress(g_csModule, "vtApiExecuteCommand");
    }
    return kFuncList;
}

VT_API void ESTerminate() {
    if (g_csModule) {
        FreeLibrary(g_csModule);
        g_csModule = nullptr;
    }
    g_csExec = nullptr;
}

VT_API void ESFreeMem(void* p) {
    (void)p;
}

VT_API long doCommand(TaggedData* argv, long argc, TaggedData* result) {
    BOOL ok = FALSE;

    __try {
        if (argc >= 1 && argv && (argv[0].type == 3 || argv[0].type == 4) && argv[0].data.strVal) {
            const char* cmd = argv[0].data.strVal;

            if (g_csExec) {
                int csResult = g_csExec(cmd);
                ok = (csResult == 0);
            }

            if (!ok) {
                if (strcmp(cmd, "cmd.edit.copy") == 0)
                    ok = SendCtrlKey(0x43);
                else if (strcmp(cmd, "cmd.edit.paste") == 0)
                    ok = SendCtrlKey(0x56);
                else if (strcmp(cmd, "cmd.edit.selectAll") == 0)
                    ok = SendCtrlKey(0x41);
                else if (strcmp(cmd, "cmd.clip.group") == 0)
                    ok = SendCtrlKey(0x47);
            }
        }
    } __except(EXCEPTION_EXECUTE_HANDLER) {
        ok = FALSE;
    }

    if (result) {
        result->type = 4;
        result->data.strVal = (char*)(ok ? kTrue : kFalse);
    }
    return 0;
}

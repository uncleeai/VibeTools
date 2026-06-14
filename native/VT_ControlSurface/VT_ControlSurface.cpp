/**
 * VT_ControlSurface - VibeTool Control Surface Plugin
 *
 * Provides access to Premiere Pro's internal command execution API
 * through the ControlSurfaceHostCommandSuite.
 *
 * Based on Adobe SDK Control Surface example.
 * Exports: vtApiExecuteCommand, vtApiVersion
 */

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <string>
#include <vector>

// SDK Headers - order matters!
#include "adobesdk/AdobesdkStringSuite.h"
#include "adobesdk/controlsurface/ControlSurfaceTypes.h"
#include "adobesdk/controlsurface/host/ControlSurfaceHostCommandSuite.h"
#include "adobesdk/controlsurface/host/ControlSurfaceHostSuite.h"
#include "adobesdk/controlsurface/plugin/ControlSurfacePluginSuite.h"
#include "adobesdk/controlsurface/plugin/ControlSurfaceSuite.h"
#include "adobesdk/controlsurface/plugin/wrapper/ControlSurfaceBase.h"
#include "adobesdk/controlsurface/plugin/wrapper/ControlSurfaceCommandBase.h"


// SPSuites
#include <SPBasic.h>
#include <SPSuites.h>

// Plugin version
#define VT_CONTROL_SURFACE_VERSION 1

//=============================================================================
// Global State (like SDK example)
//=============================================================================

namespace {
ADOBESDK_ControlSurfaceHostID sHostIdentifier =
    kADOBESDK_ControlSurfaceHost_PremierePro;
SPBasicSuite *sSPBasicSuite = nullptr;
SPSuitesSuite *sSPSuitesSuite = nullptr;
SPSuiteListRef sSuiteList = nullptr;
ADOBESDK_StringSuite1 *sStringSuite = nullptr;

// Plugin ID strings (UTF16)
ADOBESDK_UTF16Char kPluginIDString[] = {'V', 'i', 'b', 'e', 'T', 'o', 'o', 'l',
                                        '.', 'C', 'o', 'n', 't', 'r', 'o', 'l',
                                        'S', 'u', 'r', 'f', 'a', 'c', 'e', 0};
ADOBESDK_UTF16Char kPluginDisplayString[] = {
    'V', 'i', 'b', 'e', 'T', 'o', 'o', 'l', ' ', 'C', 'o', 'n', 't',
    'r', 'o', 'l', ' ', 'S', 'u', 'r', 'f', 'a', 'c', 'e', 0};

// Helper to create string
SPErr GetString(const ADOBESDK_UTF16Char *inString,
                ADOBESDK_String *outBufferAsUnicode) {
  if (sStringSuite) {
    return sStringSuite->AllocateFromUTF16(inString, outBufferAsUnicode);
  }
  return kSPBadParameterError;
}
} // namespace

//=============================================================================
// VibeTool Control Surface Class
//=============================================================================

namespace VibeTool {

class VTControlSurface : public adobesdk::ControlSurfaceBase,
                         public adobesdk::ControlSurfaceCommandBase {
public:
  VTControlSurface(ADOBESDK_ControlSurfaceHostID inHostIdentifier,
                   SPBasicSuite *inSPBasic)
      : mHostIdentifier(inHostIdentifier), mSPBasic(inSPBasic),
        mHostSuite(nullptr), mHostCommandSuite(nullptr), mHostRef(nullptr),
        mHostCommandRef(nullptr) {}

  virtual ~VTControlSurface() { SetControlSurfaceHost(nullptr); }

  void SetControlSurfaceHost(ADOBESDK_ControlSurfaceHostRef inHostRef) {
    // Release old references
    if (mHostCommandSuite) {
      mSPBasic->ReleaseSuite(kADOBESDK_ControlSurfaceHostCommandSuite,
                             kADOBESDK_ControlSurfaceHostCommandSuite_Version1);
      mHostCommandSuite = nullptr;
    }
    if (mHostSuite) {
      mSPBasic->ReleaseSuite(kADOBESDK_ControlSurfaceHostSuite,
                             kADOBESDK_ControlSurfaceHostSuite_Version1);
      mHostSuite = nullptr;
    }
    mHostCommandRef = nullptr;
    mHostRef = inHostRef;

    // Acquire new references
    if (mHostRef && mSPBasic) {
      mSPBasic->AcquireSuite(kADOBESDK_ControlSurfaceHostSuite,
                             kADOBESDK_ControlSurfaceHostSuite_Version1,
                             (const void **)&mHostSuite);

      mSPBasic->AcquireSuite(kADOBESDK_ControlSurfaceHostCommandSuite,
                             kADOBESDK_ControlSurfaceHostCommandSuite_Version1,
                             (const void **)&mHostCommandSuite);

      if (mHostSuite) {
        // Use GetCommandRef instead of AcquireCommandHandler
        mHostSuite->GetCommandRef(mHostRef, &mHostCommandRef);
      }
    }
  }

  ADOBESDK_ControlSurfaceRef GetControlSurfaceRef() {
    return reinterpret_cast<ADOBESDK_ControlSurfaceRef>(
        static_cast<adobesdk::ControlSurfaceBase *>(this));
  }

  // Execute a command - this is what we need!
  int ExecuteCommand(const char *commandID) {
    if (!mHostCommandSuite || !mHostCommandRef || !commandID || !sStringSuite) {
      return -1;
    }

    // Convert command ID to ADOBESDK_String
    ADOBESDK_String cmdString = {};
    SPErr err = sStringSuite->AllocateFromUTF8(
        reinterpret_cast<const ADOBESDK_UTF8Char *>(commandID), &cmdString);
    if (err != kSPNoError) {
      return -2;
    }

    // Execute the command (nullptr context = global context)
    err =
        mHostCommandSuite->ExecuteCommand(mHostCommandRef, nullptr, &cmdString);

    // Free the string using DisposeString
    sStringSuite->DisposeString(&cmdString);

    return (err == kSPNoError) ? 0 : static_cast<int>(err);
  }

  // Enumerate all available Premiere commands via ControlSurface
  const char* EnumerateCommands() {
    if (!mHostCommandSuite || !mHostCommandRef || !sStringSuite) {
      return "[]";
    }

    uint32_t count = 0;
    SPErr err = mHostCommandSuite->GetCommandCount(mHostCommandRef, &count);
    if (err != kSPNoError) return "[]";

    std::string json = "[";
    bool first = true;

    for (uint32_t i = 0; i < count && i < 5000; i++) {
      ADOBESDK_String ctxID = {}, ctxName = {}, cmdID = {}, cmdName = {};
      err = mHostCommandSuite->GetCommand(mHostCommandRef, i,
                                           &ctxID, &ctxName, &cmdID, &cmdName);
      if (err != kSPNoError) continue;

      // Convert ADOBESDK_String to UTF8
      auto toUTF8 = [](const ADOBESDK_String& src, std::string& out) {
        uint32_t bufSize = 256;
        std::vector<ADOBESDK_UTF8Char> buf(bufSize);
        SPErr r = sStringSuite->CopyToUTF8String(&src, buf.data(), &bufSize);
        if (r == kADOBESDK_Error_StringBufferTooSmall) {
          buf.resize(bufSize);
          r = sStringSuite->CopyToUTF8String(&src, buf.data(), &bufSize);
        }
        if (r == kSPNoError) out.assign(reinterpret_cast<const char*>(buf.data()), bufSize - 1);
      };

      std::string ctxIDStr, ctxNameStr, cmdIDStr, cmdNameStr;
      toUTF8(ctxID, ctxIDStr);
      toUTF8(ctxName, ctxNameStr);
      toUTF8(cmdID, cmdIDStr);
      toUTF8(cmdName, cmdNameStr);

      // Escape JSON strings
      auto jsonEscape = [](const std::string& s) -> std::string {
        std::string out;
        out.reserve(s.size() + 4);
        for (char c : s) {
          if (c == '"') out += "\\\"";
          else if (c == '\\') out += "\\\\";
          else if (c == '\n') out += "\\n";
          else if (c == '\r') out += "\\r";
          else if (c == '\t') out += "\\t";
          else if ((unsigned char)c < 32) { out += "?"; }
          else out += c;
        }
        return out;
      };

      if (!first) json += ",";
      first = false;

      json += "{\"id\":\"" + jsonEscape(cmdIDStr) + "\"";
      json += ",\"name\":\"" + jsonEscape(cmdNameStr) + "\"";
      json += ",\"ctxId\":\"" + jsonEscape(ctxIDStr) + "\"";
      json += ",\"ctxName\":\"" + jsonEscape(ctxNameStr) + "\"}";

      // Dispose allocated strings
      sStringSuite->DisposeString(&ctxID);
      sStringSuite->DisposeString(&ctxName);
      sStringSuite->DisposeString(&cmdID);
      sStringSuite->DisposeString(&cmdName);
    }

    json += "]";

    thread_local std::string cachedResult;
    cachedResult = std::move(json);
    return cachedResult.c_str();
  }

  static void RegisterSuites(SPSuitesSuite *inSPSuitesSuite,
                             SPSuiteListRef inSuiteList) {
    adobesdk::ControlSurfaceBase::RegisterSuite(inSPSuitesSuite, inSuiteList);
    adobesdk::ControlSurfaceCommandBase::RegisterSuite(inSPSuitesSuite,
                                                       inSuiteList);
  }

private:
  ADOBESDK_ControlSurfaceHostID mHostIdentifier;
  SPBasicSuite *mSPBasic;
  ADOBESDK_ControlSurfaceHostSuite1 *mHostSuite;
  ADOBESDK_ControlSurfaceHostCommandSuite1 *mHostCommandSuite;
  ADOBESDK_ControlSurfaceHostRef mHostRef;
  ADOBESDK_ControlSurfaceHostCommandRef mHostCommandRef;
};

//=============================================================================
// Plugin Instance
//=============================================================================

class VTControlSurfacePlugin {
public:
  VTControlSurfacePlugin() : mSurface(nullptr) {}

  ~VTControlSurfacePlugin() { Disconnect(); }

  ADOBESDK_ControlSurfaceRef Connect(ADOBESDK_ControlSurfaceHostRef inHostRef) {
    mSurface = new VTControlSurface(sHostIdentifier, sSPBasicSuite);
    mSurface->SetControlSurfaceHost(inHostRef);
    return mSurface->GetControlSurfaceRef();
  }

  void Disconnect() {
    if (mSurface) {
      delete mSurface;
      mSurface = nullptr;
    }
  }

  VTControlSurface *GetSurface() { return mSurface; }

private:
  VTControlSurface *mSurface;
};

// Global plugin instance for external access
VTControlSurfacePlugin *gPluginInstance = nullptr;

} // namespace VibeTool

//=============================================================================
// Plugin Suite Callbacks (same pattern as SDK example)
//=============================================================================

namespace {

SPErr Plugin_Connect(ADOBESDK_ControlSurfacePluginRef inPluginRef,
                     ADOBESDK_ControlSurfaceHostRef inHostRef,
                     ADOBESDK_ControlSurfaceRef *outRef) {
  VibeTool::VTControlSurfacePlugin *plugin =
      reinterpret_cast<VibeTool::VTControlSurfacePlugin *>(inPluginRef);
  *outRef = plugin->Connect(inHostRef);
  VibeTool::gPluginInstance = plugin;
  return kSPNoError;
}

SPErr Plugin_Disconnect(ADOBESDK_ControlSurfacePluginRef inPluginRef) {
  reinterpret_cast<VibeTool::VTControlSurfacePlugin *>(inPluginRef)
      ->Disconnect();
  VibeTool::gPluginInstance = nullptr;
  return kSPNoError;
}

SPErr Plugin_GetPluginID(ADOBESDK_ControlSurfacePluginRef,
                         ADOBESDK_String *outBuffer) {
  return GetString(kPluginIDString, outBuffer);
}

SPErr Plugin_GetPluginDisplayString(ADOBESDK_ControlSurfacePluginRef,
                                    ADOBESDK_String *outBuffer) {
  return GetString(kPluginDisplayString, outBuffer);
}

SPErr Plugin_GetPluginSettings(ADOBESDK_ControlSurfacePluginRef,
                               ADOBESDK_String *) {
  return kSPUnimplementedError;
}

SPErr Plugin_SetPluginSettings(ADOBESDK_ControlSurfacePluginRef,
                               const ADOBESDK_String *) {
  return kSPUnimplementedError;
}

SPErr Plugin_HasConfigurationDialog(ADOBESDK_ControlSurfacePluginRef,
                                    ADOBESDK_Boolean *outHas) {
  *outHas = kAdobesdk_False;
  return kSPNoError;
}

SPErr Plugin_RunConfigurationDialog(ADOBESDK_ControlSurfacePluginRef, void *,
                                    ADOBESDK_Boolean *) {
  return kSPUnimplementedError;
}

SPErr Plugin_Suspend(ADOBESDK_ControlSurfacePluginRef) { return kSPNoError; }

SPErr Plugin_Resume(ADOBESDK_ControlSurfacePluginRef) { return kSPNoError; }

ADOBESDK_ControlSurfacePluginSuite1 sPluginSuite = {
    Plugin_Connect,
    Plugin_Disconnect,
    Plugin_GetPluginID,
    Plugin_GetPluginDisplayString,
    Plugin_GetPluginSettings,
    Plugin_SetPluginSettings,
    Plugin_HasConfigurationDialog,
    Plugin_RunConfigurationDialog,
    Plugin_Suspend,
    Plugin_Resume};

//=========================================================================
// Plugin Lifecycle
//=========================================================================

SPErr Plugin_Startup() {
  SPErr result = sSPBasicSuite->AcquireSuite(kADOBESDK_StringSuite,
                                             kADOBESDK_StringSuite_Version1,
                                             (const void **)&sStringSuite);

  if (result == kSPNoError) {
    result = sSPBasicSuite->AcquireSuite(kSPSuitesSuite, kSPSuitesSuiteVersion,
                                         (const void **)&sSPSuitesSuite);

    if (result == kSPNoError) {
      SPSuiteListRef suiteList = nullptr;
      if (sSPSuitesSuite->AllocateSuiteList(kSPRuntimeStringPool,
                                            kSPRuntimePluginList,
                                            &suiteList) == kSPNoError) {
        sSuiteList = suiteList;

        SPSuiteRef pluginSuiteRef = nullptr;
        sSPSuitesSuite->AddSuite(sSuiteList, nullptr,
                                 kADOBESDK_ControlSurfacePluginSuite,
                                 kADOBESDK_ControlSurfacePluginSuite_Version1,
                                 kADOBESDK_ControlSurfacePluginSuite_Version1,
                                 &sPluginSuite, &pluginSuiteRef);

        VibeTool::VTControlSurface::RegisterSuites(sSPSuitesSuite, sSuiteList);
      }
    }
  }
  return result;
}

SPErr Plugin_Shutdown() {
  if (sSuiteList) {
    sSPSuitesSuite->FreeSuiteList(sSuiteList);
    sSuiteList = nullptr;
  }
  if (sStringSuite) {
    sSPBasicSuite->ReleaseSuite(kADOBESDK_StringSuite,
                                kADOBESDK_StringSuite_Version1);
    sStringSuite = nullptr;
  }
  return kSPNoError;
}

SPErr Plugin_CreateInstance(ADOBESDK_ControlSurfacePluginRef *outRef) {
  *outRef = reinterpret_cast<ADOBESDK_ControlSurfacePluginRef>(
      new VibeTool::VTControlSurfacePlugin());
  return kSPNoError;
}

SPErr Plugin_DeleteInstance(ADOBESDK_ControlSurfacePluginRef inRef) {
  delete reinterpret_cast<VibeTool::VTControlSurfacePlugin *>(inRef);
  return kSPNoError;
}

SPErr Plugin_GetSuiteList(SPSuiteListRef *outRef) {
  *outRef = sSuiteList;
  return kSPNoError;
}

ADOBESDK_ControlSurfacePluginFuncs sPluginFuncs = {
    Plugin_Startup, Plugin_Shutdown, Plugin_CreateInstance,
    Plugin_DeleteInstance, Plugin_GetSuiteList};

} // anonymous namespace

//=============================================================================
// EXPORTED FUNCTIONS - For ExternalObject.dll to call
//=============================================================================

extern "C" {

/**
 * Execute a Premiere command by ID
 * @param commandID Command identifier (e.g., "cmd.edit.paste", "cmd.edit.copy")
 * @return 0 on success, error code otherwise
 */
__declspec(dllexport) int vtApiExecuteCommand(const char *commandID) {
  if (!VibeTool::gPluginInstance) {
    return -1; // Plugin not initialized
  }

  VibeTool::VTControlSurface *surface = VibeTool::gPluginInstance->GetSurface();
  if (!surface) {
    return -2; // No control surface
  }

  return surface->ExecuteCommand(commandID);
}

/**
 * Enumerate all available Premiere commands via ControlSurface
 * @return JSON array of command objects [{id, name, ctxId, ctxName}, ...]
 */
__declspec(dllexport) const char* vtApiEnumerateCommands() {
  if (!VibeTool::gPluginInstance) {
    return "[]";
  }
  VibeTool::VTControlSurface *surface = VibeTool::gPluginInstance->GetSurface();
  if (!surface) {
    return "[]";
  }
  return surface->EnumerateCommands();
}

/**
 * Get API version
 * @return Version number
 */
__declspec(dllexport) int vtApiVersion() { return VT_CONTROL_SURFACE_VERSION; }

/**
 * Check if the plugin is initialized and ready
 * @return 1 if ready, 0 otherwise
 */
__declspec(dllexport) int vtApiIsReady() {
  return (VibeTool::gPluginInstance && VibeTool::gPluginInstance->GetSurface())
             ? 1
             : 0;
}

} // extern "C"

//=============================================================================
// PLUGIN ENTRY POINT
//=============================================================================

extern "C" __declspec(dllexport) SPErr EntryPoint(
    SPBasicSuite *inSPBasic, uint32_t inMajorVersion, uint32_t inMinorVersion,
    ADOBESDK_ControlSurfaceHostID inHostIdentifier,
    ADOBESDK_ControlSurfacePluginFuncs *outPluginFuncs) {
  sHostIdentifier = inHostIdentifier;
  sSPBasicSuite = inSPBasic;

  if (sSPBasicSuite) {
    *outPluginFuncs = sPluginFuncs;
    return kSPNoError;
  }

  return kSPBadParameterError;
}

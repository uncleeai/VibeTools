/**
 * VT_Importer.cpp - VibeTools Native Importer Plugin for Adobe Premiere Pro
 *
 * This plugin registers the .vtbk file extension and creates placeholder
 * clips when files are dragged to the timeline. This allows precise track
 * targeting during drag & drop.
 *
 * Based on Adobe SDK_Custom_Import example
 */

#include "VT_Importer.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

// Simple JSON parsing helpers
static int FindInt(const char *json, const char *key, int defaultVal) {
  char searchKey[64];
  sprintf_s(searchKey, sizeof(searchKey), "\"%s\":", key);
  const char *pos = strstr(json, searchKey);
  if (!pos)
    return defaultVal;
  pos += strlen(searchKey);
  while (*pos && (*pos == ' ' || *pos == '\t'))
    pos++;
  return atoi(pos);
}

static bool FindBool(const char *json, const char *key, bool defaultVal) {
  char searchKeyTrue[64], searchKeyFalse[64];
  sprintf_s(searchKeyTrue, sizeof(searchKeyTrue), "\"%s\":true", key);
  sprintf_s(searchKeyFalse, sizeof(searchKeyFalse), "\"%s\":false", key);

  // Also check with space after colon
  char searchKeyTrue2[64], searchKeyFalse2[64];
  sprintf_s(searchKeyTrue2, sizeof(searchKeyTrue2), "\"%s\": true", key);
  sprintf_s(searchKeyFalse2, sizeof(searchKeyFalse2), "\"%s\": false", key);

  if (strstr(json, searchKeyTrue) || strstr(json, searchKeyTrue2))
    return true;
  if (strstr(json, searchKeyFalse) || strstr(json, searchKeyFalse2))
    return false;
  return defaultVal;
}

bool ParseVTBricksFile(const char *jsonContent, VTBricksData *outData) {
  OutputDebugStringA("VT_Importer: ParseVTBricksFile called\n");
  if (!jsonContent || !outData) {
    OutputDebugStringA("VT_Importer: ParseVTBricksFile - null input\n");
    return false;
  }

  OutputDebugStringA("VT_Importer: JSON content: ");
  OutputDebugStringA(jsonContent);
  OutputDebugStringA("\n");

  // Initialize with defaults
  memset(outData, 0, sizeof(VTBricksData));
  outData->numStreams = 1;
  outData->mainStream.hasVideo = kPrTrue;
  outData->mainStream.hasAudio = kPrTrue;
  outData->mainStream.videoFrameRate = 30000;
  outData->mainStream.videoFrameRateDivisor = 1001;
  outData->mainStream.videoFrameCount = 30;

  // Check for streams array
  if (strstr(jsonContent, "\"streams\"") == nullptr) {
    OutputDebugStringA("VT_Importer: ParseVTBricksFile - no streams found\n");
    return false;
  }
  OutputDebugStringA("VT_Importer: ParseVTBricksFile - found streams\n");

  // Parse values from JSON
  outData->mainStream.hasVideo =
      FindBool(jsonContent, "hasVideo", true) ? kPrTrue : kPrFalse;
  outData->mainStream.hasAudio =
      FindBool(jsonContent, "hasAudio", true) ? kPrTrue : kPrFalse;
  outData->mainStream.videoFrameRate =
      FindInt(jsonContent, "videoFrameRate", 30000);
  outData->mainStream.videoFrameRateDivisor =
      FindInt(jsonContent, "videoFrameRateDivisor", 1001);
  outData->mainStream.videoFrameCount =
      FindInt(jsonContent, "videoFrameCount", 30);

  // Parse our extra metadata
  outData->assetId = FindInt(jsonContent, "_vtAssetId", 0);

  return true;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

PREMPLUGENTRY DllExport xImportEntry(csSDK_int32 selector, imStdParms *stdParms,
                                     void *param1, void *param2) {
  prMALError result = imUnsupported;

  switch (selector) {
  case imInit:
    result = SDKInit(stdParms, reinterpret_cast<imImportInfoRec *>(param1));
    break;

  case imGetIndFormat:
    result = SDKGetIndFormat(stdParms, reinterpret_cast<csSDK_size_t>(param1),
                             reinterpret_cast<imIndFormatRec *>(param2));
    break;

  case imOpenFile8:
    result = SDKOpenFile8(stdParms, reinterpret_cast<imFileRef *>(param1),
                          reinterpret_cast<imFileOpenRec8 *>(param2));
    break;

  case imGetInfo8:
    result = SDKGetInfo8(stdParms, reinterpret_cast<imFileAccessRec8 *>(param1),
                         reinterpret_cast<imFileInfoRec8 *>(param2));
    break;

  case imQuietFile:
    result =
        SDKQuietFile(stdParms, reinterpret_cast<imFileRef *>(param1), param2);
    break;

  case imCloseFile:
    result =
        SDKCloseFile(stdParms, reinterpret_cast<imFileRef *>(param1), param2);
    break;

  case imImportImage:
    result = SDKImportImage(stdParms, *reinterpret_cast<imFileRef *>(param1),
                            reinterpret_cast<imImportImageRec *>(param2));
    break;

  case imGetSupports8:
    result = malSupports8;
    break;

  case imGetSupports7:
    result = malSupports7;
    break;
  }

  return result;
}

// ============================================================================
// SDK Functions
// ============================================================================

prMALError SDKInit(imStdParms *stdParms, imImportInfoRec *importInfo) {
  // Basic importer that doesn't need dialog or special setup
  importInfo->canSave = kPrFalse;
  importInfo->canDelete = kPrFalse;
  importInfo->canCalcSizes = kPrFalse;
  importInfo->canTrim = kPrFalse;
  importInfo->hasSetup = kPrFalse;
  importInfo->setupOnDblClk = kPrFalse;
  importInfo->dontCache = kPrFalse;
  importInfo->keepLoaded = kPrFalse;
  importInfo->priority = 0;
  importInfo->avoidAudioConform = kPrTrue;

  // Synthetic importer (no file content, just metadata)
  importInfo->noFile = kPrFalse;
  importInfo->addToMenu = imMenuNone;

  return imIsCacheable;
}

prMALError SDKGetIndFormat(imStdParms *stdparms, csSDK_size_t index,
                           imIndFormatRec *SDKIndFormatRec) {
  if (index != 0) {
    return imBadFormatIndex;
  }

  // Our file type identifier - 4 character code
  SDKIndFormatRec->filetype = VT_IMPORTER_MAGIC;

  // CRITICAL: Enable import flags - without these Premiere won't recognize us!
  SDKIndFormatRec->flags = xfCanOpen + xfCanImport + xfIsMovie;

  // Format names
  char formatname[255] = "VibeTools Placeholder";
  char shortname[32] = "VTBricks";
  char platformXten[256] = "vtbk\0\0";

#ifdef PRWIN_ENV
  strcpy_s(SDKIndFormatRec->FormatName, sizeof(SDKIndFormatRec->FormatName),
           formatname);
  strcpy_s(SDKIndFormatRec->FormatShortName,
           sizeof(SDKIndFormatRec->FormatShortName), shortname);
  strcpy_s(SDKIndFormatRec->PlatformExtension,
           sizeof(SDKIndFormatRec->PlatformExtension), platformXten);
#else
  strcpy(SDKIndFormatRec->FormatName, formatname);
  strcpy(SDKIndFormatRec->FormatShortName, shortname);
  strcpy(SDKIndFormatRec->PlatformExtension, platformXten);
#endif

  return imNoErr;
}

prMALError SDKOpenFile8(imStdParms *stdParms, imFileRef *SDKfileRef,
                        imFileOpenRec8 *SDKfileOpenRec8) {
  prMALError result = malNoError;
  ImporterLocalRecH localRecH;

  OutputDebugStringA("VT_Importer: SDKOpenFile8 called\n");

  // Check if we already have private data
  if (SDKfileOpenRec8->privatedata) {
    localRecH =
        reinterpret_cast<ImporterLocalRecH>(SDKfileOpenRec8->privatedata);
  } else {
    // Allocate new local data
    localRecH = reinterpret_cast<ImporterLocalRecH>(
        stdParms->piSuites->memFuncs->newHandle(sizeof(ImporterLocalRec)));
    if (!localRecH) {
      OutputDebugStringA("VT_Importer: Failed to allocate memory\n");
      return imMemErr;
    }
    memset(*localRecH, 0, sizeof(ImporterLocalRec));
    SDKfileOpenRec8->privatedata = reinterpret_cast<void *>(localRecH);
  }

  // Open the file (like SDK example - don't read content here!)
#ifdef PRWIN_ENV
  (*localRecH)->fileRef =
      CreateFileW(reinterpret_cast<LPCWSTR>(SDKfileOpenRec8->fileinfo.filepath),
                  GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                  FILE_ATTRIBUTE_NORMAL, NULL);

  if ((*localRecH)->fileRef == INVALID_HANDLE_VALUE) {
    OutputDebugStringA("VT_Importer: CreateFileW failed\n");
    result = imBadFile;
  } else {
    // SUCCESS - set file reference and type (CRITICAL!)
    *SDKfileRef = (*localRecH)->fileRef;
    SDKfileOpenRec8->fileinfo.fileref = (*localRecH)->fileRef;
    SDKfileOpenRec8->fileinfo.filetype = VT_IMPORTER_MAGIC;
    OutputDebugStringA("VT_Importer: SDKOpenFile8 SUCCESS\n");
  }
#endif

  return result;
}

prMALError SDKGetInfo8(imStdParms *stdParms, imFileAccessRec8 *fileAccess8,
                       imFileInfoRec8 *fileInfo8) {
  ImporterLocalRecH localRecH = nullptr;

  // Get our local data
  if (fileInfo8->privatedata) {
    localRecH = reinterpret_cast<ImporterLocalRecH>(fileInfo8->privatedata);
  } else {
    // Need to allocate
    localRecH = reinterpret_cast<ImporterLocalRecH>(
        stdParms->piSuites->memFuncs->newHandle(sizeof(ImporterLocalRec)));
    if (!localRecH) {
      return imMemErr;
    }
    memset(*localRecH, 0, sizeof(ImporterLocalRec));
    (*localRecH)->BasicSuite = stdParms->piSuites->utilFuncs->getSPBasicSuite();
    if ((*localRecH)->BasicSuite) {
      (*localRecH)
          ->BasicSuite->AcquireSuite(kPrSDKTimeSuite, kPrSDKTimeSuiteVersion,
                                     (const void **)&(*localRecH)->TimeSuite);
    }
    fileInfo8->privatedata = reinterpret_cast<void *>(localRecH);

    // Re-read file data
#ifdef PRWIN_ENV
    HANDLE hFile = CreateFileW(reinterpret_cast<LPCWSTR>(fileAccess8->filepath),
                               GENERIC_READ, FILE_SHARE_READ, NULL,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);

    if (hFile != INVALID_HANDLE_VALUE) {
      DWORD fileSize = GetFileSize(hFile, NULL);
      if (fileSize > 0 && fileSize < 65536) {
        char *jsonBuffer = (char *)malloc(fileSize + 1);
        DWORD bytesRead = 0;

        if (ReadFile(hFile, jsonBuffer, fileSize, &bytesRead, NULL)) {
          jsonBuffer[bytesRead] = '\0';
          ParseVTBricksFile(jsonBuffer, &(*localRecH)->fileData);
        }
        free(jsonBuffer);
      }
      CloseHandle(hFile);
    }
#endif
  }

  VTBricksData &data = (*localRecH)->fileData;

  // Set clip name based on filename
#ifdef PRWIN_ENV
  wcscpy_s(reinterpret_cast<wchar_t *>(fileInfo8->streamName), 256,
           L"VT Placeholder");
#endif

  // Always video+audio placeholder (Premiere requires at least one video stream)
  OutputDebugStringA("VT_Importer: SDKGetInfo8 - setting video+audio info\n");

  fileInfo8->hasVideo = kPrTrue;
  fileInfo8->vidInfo.subType = VT_IMPORTER_MAGIC;
  fileInfo8->vidInfo.depth = 32;
  fileInfo8->vidInfo.noDuration = imNoDurationFalse;
  fileInfo8->vidInfo.isStill = kPrFalse;
  fileInfo8->vidInfo.isRollCrawl = kPrFalse;

  // Use standard HD resolution for placeholder
  fileInfo8->vidInfo.imageWidth = 1920;
  fileInfo8->vidInfo.imageHeight = 1080;
  fileInfo8->vidInfo.pixelAspectNum = 1;
  fileInfo8->vidInfo.pixelAspectDen = 1;

  // Use parsed video params or defaults
  fileInfo8->vidScale = data.mainStream.videoFrameRate > 0 ? data.mainStream.videoFrameRate : 30000;
  fileInfo8->vidSampleSize = data.mainStream.videoFrameRateDivisor > 0 ? data.mainStream.videoFrameRateDivisor : 1001;
  fileInfo8->vidDuration = data.mainStream.videoFrameCount > 0 ? (csSDK_int32)(data.mainStream.videoFrameCount * data.mainStream.videoFrameRateDivisor) : (30 * 1001);

  fileInfo8->vidInfo.alphaType = alphaNone;

  // Audio info — always present so placeholder creates linked audio on audio track
  fileInfo8->hasAudio = kPrTrue;
  fileInfo8->audInfo.numChannels = 2;
  fileInfo8->audInfo.sampleRate = 48000.0f;
  fileInfo8->audInfo.sampleType = kPrAudioSampleType_32BitFloat;

  if (data.mainStream.videoFrameRate > 0) {
    double seconds = (double)data.mainStream.videoFrameCount *
                     data.mainStream.videoFrameRateDivisor /
                     data.mainStream.videoFrameRate;
    fileInfo8->audDuration = (csSDK_int64)(seconds * 48000.0);
  } else {
    fileInfo8->audDuration = 48000;
  }

  return imNoErr;
}

prMALError SDKQuietFile(imStdParms *stdParms, imFileRef *SDKfileRef,
                        void *privateData) {
  // Close file handle if open
  if (SDKfileRef && *SDKfileRef != imInvalidHandleValue) {
#ifdef PRWIN_ENV
    CloseHandle(*SDKfileRef);
#endif
    *SDKfileRef = imInvalidHandleValue;
  }

  return imNoErr;
}

prMALError SDKCloseFile(imStdParms *stdParms, imFileRef *SDKfileRef,
                        void *privateData) {
  SDKQuietFile(stdParms, SDKfileRef, privateData);

  // Free private data
  if (privateData) {
    ImporterLocalRecH localRecH =
        reinterpret_cast<ImporterLocalRecH>(privateData);

    // Release suites
    if ((*localRecH)->BasicSuite && (*localRecH)->TimeSuite) {
      (*localRecH)
          ->BasicSuite->ReleaseSuite(kPrSDKTimeSuite, kPrSDKTimeSuiteVersion);
    }

    stdParms->piSuites->memFuncs->disposeHandle(
        reinterpret_cast<char **>(localRecH));
  }

  return imNoErr;
}

prMALError SDKImportImage(imStdParms *stdParms, imFileRef SDKfileRef,
                          imImportImageRec *imageRec) {
  // For our placeholder, we just return a solid color frame
  // This will be visible briefly during drag

  ImporterLocalRecH localRecH =
      reinterpret_cast<ImporterLocalRecH>(imageRec->privatedata);
  if (!localRecH) {
    return imBadFile;
  }

  // Get the destination buffer info
  char *destPixels = imageRec->pix;
  csSDK_int32 destWidth = imageRec->dstWidth;
  csSDK_int32 destHeight = imageRec->dstHeight;
  csSDK_int32 destRowBytes = imageRec->rowbytes;

  if (!destPixels) {
    return imBadFile;
  }

  // Fill with a distinctive color (purple/violet for VibeTools)
  // BGRA format (32-bit)
  for (csSDK_int32 y = 0; y < destHeight; y++) {
    csSDK_uint32 *row =
        reinterpret_cast<csSDK_uint32 *>(destPixels + y * destRowBytes);
    for (csSDK_int32 x = 0; x < destWidth; x++) {
      // Purple: R=128, G=0, B=255, A=255
      // In BGRA: B=255, G=0, R=128, A=255
      row[x] = 0xFF8000FF; // ARGB stored as BGRA
    }
  }

  return imNoErr;
}

// DLL Entry Point
BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpReserved) {
  switch (fdwReason) {
  case DLL_PROCESS_ATTACH:
    DisableThreadLibraryCalls(hinstDLL);
    break;
  case DLL_PROCESS_DETACH:
    break;
  }
  return TRUE;
}

/**
 * VT_Importer.h - VibeTools Native Importer Plugin
 * Header file with structures and definitions
 */

#ifndef VT_IMPORTER_H
#define VT_IMPORTER_H

// Premiere Pro SDK headers
#include "PrSDKEntry.h"
#include "PrSDKImport.h"
#include "PrSDKMALErrors.h"
#include "PrSDKTimeSuite.h"
#include "PrSDKTypes.h"


// Windows headers
#ifdef PRWIN_ENV
#include <windows.h>
#endif

// Our file format magic number
#define VT_IMPORTER_MAGIC 'VTBK'

// File extension (without dot)
#define VT_FILE_EXTENSION "vtbk"
#define VT_FORMAT_NAME "VibeTools Placeholder"
#define VT_FORMAT_SHORT_NAME "VTBricks"

// Our file structure - matches JSON format
struct VTBricksStream {
  prBool hasVideo;
  prBool hasAudio;
  csSDK_int32 videoFrameRate;        // e.g. 30000
  csSDK_int32 videoFrameRateDivisor; // e.g. 1001 for 29.97
  csSDK_int32 videoFrameCount;       // Duration in frames
};

// Simple file data structure
struct VTBricksData {
  csSDK_int32 numStreams;
  VTBricksStream mainStream;
  // Extra metadata
  csSDK_int32 assetId;
  prUTF16Char assetPath[kPrMaxPath];
};

// Local data stored per file
typedef struct {
  VTBricksData fileData;
  imFileRef fileRef;
  SPBasicSuite *BasicSuite;
  PrSDKTimeSuite *TimeSuite;
  prUTF16Char filePath[kPrMaxPath];
} ImporterLocalRec;

typedef ImporterLocalRec **ImporterLocalRecH;

// Function prototypes
prMALError SDKInit(imStdParms *stdParms, imImportInfoRec *importInfo);
prMALError SDKGetIndFormat(imStdParms *stdparms, csSDK_size_t index,
                           imIndFormatRec *SDKIndFormatRec);
prMALError SDKOpenFile8(imStdParms *stdParms, imFileRef *SDKfileRef,
                        imFileOpenRec8 *SDKfileOpenRec8);
prMALError SDKGetInfo8(imStdParms *stdParms, imFileAccessRec8 *fileAccess8,
                       imFileInfoRec8 *fileInfo8);
prMALError SDKQuietFile(imStdParms *stdParms, imFileRef *SDKfileRef,
                        void *privateData);
prMALError SDKCloseFile(imStdParms *stdParms, imFileRef *SDKfileRef,
                        void *privateData);
prMALError SDKImportImage(imStdParms *stdParms, imFileRef SDKfileRef,
                          imImportImageRec *imageRec);

// Helper function to parse JSON
bool ParseVTBricksFile(const char *jsonContent, VTBricksData *outData);

#endif // VT_IMPORTER_H

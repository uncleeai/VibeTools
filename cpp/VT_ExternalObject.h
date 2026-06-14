#pragma once

// Adobe ExtendScript ExternalObject interface
#ifdef VT_EXTERNALOBJECT_EXPORTS
#define VT_API __declspec(dllexport)
#else
#define VT_API __declspec(dllimport)
#endif

// Adobe's tagged data structure for ExtendScript communication
struct TaggedData {
  union {
    long intVal;
    double fltVal;
    char *strVal;
  } data;
  long type;
  long filler;
};

// Adobe ExtendScript tagged data (type 3/4 = string)

extern "C" {
VT_API long ESGetVersion();
VT_API const char *ESInitialize(const TaggedData **argv, long argc);
VT_API void ESTerminate();
VT_API void ESFreeMem(void *p);
VT_API long doCommand(TaggedData *argv, long argc, TaggedData *result);
}

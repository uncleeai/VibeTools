cmake_minimum_required(VERSION 3.15)
project(VT_ExternalObject VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(VT_ExternalObject SHARED
    VT_ExternalObject.cpp
    VT_ExternalObject.def
)

target_link_libraries(VT_ExternalObject PRIVATE
    user32
)

target_compile_options(VT_ExternalObject PRIVATE /EHa)

target_compile_definitions(VT_ExternalObject PRIVATE
    VT_EXTERNALOBJECT_EXPORTS
    _WINDOWS
    _USRDLL
)

set_target_properties(VT_ExternalObject PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_SOURCE_DIR}/../support_files/debug"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/../support_files"
    LIBRARY_OUTPUT_DIRECTORY_DEBUG "${CMAKE_SOURCE_DIR}/../support_files/debug"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/../support_files"
)

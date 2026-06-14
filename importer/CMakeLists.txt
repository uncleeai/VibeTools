cmake_minimum_required(VERSION 3.15)
project(VT_Importer VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Get parent directory (VibeTool extension root)
get_filename_component(EXTENSION_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

# Adobe Premiere Pro SDK path - inside our extension
set(PREMIERE_SDK_HEADERS "${EXTENSION_ROOT}/Premiere_Pro_24.0_C++_Win_SDK/Premiere_Pro_24.0_SDK/Examples/Headers")

if(NOT EXISTS "${PREMIERE_SDK_HEADERS}/PrSDKTypes.h")
    message(FATAL_ERROR "SDK Headers not found at: ${PREMIERE_SDK_HEADERS}")
endif()

message(STATUS "SDK Headers Path: ${PREMIERE_SDK_HEADERS}")

# Plugin sources
set(SOURCES
    VT_Importer.cpp
    VT_Importer.h
)

# Create shared library (.prm is just a renamed .dll)  
add_library(VT_Importer SHARED ${SOURCES})

# Module definition file for exports
if(WIN32)
    target_sources(VT_Importer PRIVATE 
        VT_Importer.def
        VT_Importer.rc  # IMPT resource required for Premiere Pro
    )
endif()

# Include directories
target_include_directories(VT_Importer PRIVATE
    ${PREMIERE_SDK_HEADERS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Windows definitions
if(WIN32)
    target_compile_definitions(VT_Importer PRIVATE
        _WINDOWS
        WIN32
        PRWIN_ENV
        _CRT_SECURE_NO_WARNINGS
    )
    
    # Output as .prm file in support_files
    set_target_properties(VT_Importer PROPERTIES
        SUFFIX ".prm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
    )
endif()

# Post-build: copy to support_files
add_custom_command(TARGET VT_Importer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy 
        "$<TARGET_FILE:VT_Importer>"
        "${EXTENSION_ROOT}/support_files/VT_Importer.prm"
    COMMENT "Copying VT_Importer.prm to support_files"
)

message(STATUS "Extension Root: ${EXTENSION_ROOT}")
message(STATUS "Output will be copied to: ${EXTENSION_ROOT}/support_files/VT_Importer.prm")

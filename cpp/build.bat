@echo off
REM Build script for VT_ExternalObject.dll
REM Requires Visual Studio with C++ Desktop Development

echo ========================================
echo Building VT_ExternalObject.dll
echo ========================================

REM Create build directory and configure
if not exist build mkdir build

cmake -B build -S . -G "Visual Studio 17 2022" -A x64
if %ERRORLEVEL% NEQ 0 (
    echo CMake configuration FAILED!
    exit /b 1
)

REM Build Release version
cmake --build build --config Release
if %ERRORLEVEL% NEQ 0 (
    echo BUILD FAILED! Check the output above for errors.
    exit /b 1
)

REM Copy to support_files
copy /Y "build\Release\VT_ExternalObject.dll" "..\\support_files\\" > nul
if %ERRORLEVEL% EQU 0 (
    echo ========================================
    echo BUILD SUCCESSFUL!
    echo DLL copied to support_files folder
    echo ========================================
) else (
    echo WARNING: DLL built but copy to support_files failed
)

pause

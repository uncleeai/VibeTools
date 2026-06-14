@echo off
setlocal

REM VT_Importer Build Script
REM Requires Visual Studio 2022 and CMAKE

echo === Building VT_Importer.prm ===

REM Find Visual Studio
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VS_PATH=%%i"
)

if not defined VS_PATH (
    echo ERROR: Visual Studio with C++ tools not found
    exit /b 1
)

echo Found Visual Studio at: %VS_PATH%

REM Set up environment
call "%VS_PATH%\VC\Auxiliary\Build\vcvars64.bat"

REM Create build directory
if not exist build mkdir build
cd build

REM Configure with CMake
echo Configuring...
cmake -G "Visual Studio 17 2022" -A x64 ..
if errorlevel 1 (
    echo ERROR: CMake configuration failed
    exit /b 1
)

REM Build
echo Building...
cmake --build . --config Release
if errorlevel 1 (
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo === Build complete! ===
echo.
echo Plugin location: build\bin\Release\VT_Importer.prm
echo.
echo To install, copy the .prm file to:
echo   "C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\VibeTools\"
echo.
echo Then restart Adobe Premiere Pro.

pause

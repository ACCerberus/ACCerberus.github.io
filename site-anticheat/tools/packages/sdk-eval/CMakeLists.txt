# Cerberus Anti-Cheat SDK 0.6.0 - evaluation build
#
#   cmake -S . -B build
#   cmake --build build --config Release
#   build\example_minimal          (Windows multi-config: build\Release\example_minimal.exe)
#
# Targets:
#   cerberus_eval          static library, the evaluation implementation
#   cerberus_sdk           shared library, same code, built when CERBERUS_EVAL_SHARED=ON
#   example_minimal        smallest possible integration
#   example_session_loop   async init, V3 callbacks, simulated flag then ban

cmake_minimum_required(VERSION 3.16)

project(cerberus_sdk_eval
        VERSION 0.6.0
        DESCRIPTION "Cerberus Anti-Cheat SDK - evaluation build"
        LANGUAGES CXX)

option(CERBERUS_EVAL_SHARED   "Also build the cerberus_sdk shared library" OFF)
option(CERBERUS_EVAL_EXAMPLES "Build the example programs"                 ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

set(CERBERUS_SOURCES src/cerberus_eval_stub.cpp)
set(CERBERUS_HEADERS include/cerberus_sdk.h)

# --- static evaluation library --------------------------------------------
add_library(cerberus_eval STATIC ${CERBERUS_SOURCES} ${CERBERUS_HEADERS})
target_include_directories(cerberus_eval PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)

if(MSVC)
    target_compile_options(cerberus_eval PRIVATE /W4)
else()
    target_compile_options(cerberus_eval PRIVATE -Wall -Wextra)
endif()

add_library(cerberus::eval ALIAS cerberus_eval)

# --- optional shared library ----------------------------------------------
# Matches the name the C# binding and the Unity package load ("cerberus_sdk").
if(CERBERUS_EVAL_SHARED)
    add_library(cerberus_sdk SHARED ${CERBERUS_SOURCES} ${CERBERUS_HEADERS})
    target_include_directories(cerberus_sdk PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
    target_compile_definitions(cerberus_sdk PRIVATE CERBERUS_BUILD_SHARED)
    set_target_properties(cerberus_sdk PROPERTIES
        WINDOWS_EXPORT_ALL_SYMBOLS ON
        OUTPUT_NAME "cerberus_sdk")
endif()

# --- examples --------------------------------------------------------------
if(CERBERUS_EVAL_EXAMPLES)
    add_executable(example_minimal      examples/cpp/minimal.cpp)
    target_link_libraries(example_minimal      PRIVATE cerberus_eval)

    add_executable(example_session_loop examples/cpp/session_loop.cpp)
    target_link_libraries(example_session_loop PRIVATE cerberus_eval)
endif()

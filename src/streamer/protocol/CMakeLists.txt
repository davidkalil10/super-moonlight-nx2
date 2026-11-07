cmake_minimum_required(VERSION 3.16)
project(hbmoonlight C)

set(CMAKE_C_STANDARD 11)
set(UPSTREAM_DIR "" CACHE PATH "Directory filled by fetch.sh")
if(NOT EXISTS "${UPSTREAM_DIR}/moonlight-embedded/libgamestream/client.c")
  message(FATAL_ERROR "Run fetch.sh and pass -DUPSTREAM_DIR=<dest>")
endif()

set(BUILD_SHARED_LIBS OFF)
add_subdirectory(${UPSTREAM_DIR}/moonlight-common-c common-c)

find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)
pkg_check_modules(DEPS REQUIRED IMPORTED_TARGET opus libcurl expat uuid openssl)

set(GAMESTREAM ${UPSTREAM_DIR}/moonlight-embedded/libgamestream)
add_library(gamestream STATIC
  ${GAMESTREAM}/client.c ${GAMESTREAM}/http.c ${GAMESTREAM}/mkcert.c ${GAMESTREAM}/xml.c)
target_include_directories(gamestream PUBLIC
  ${GAMESTREAM} ${UPSTREAM_DIR}/moonlight-common-c/src)
target_link_libraries(gamestream PUBLIC moonlight-common-c PkgConfig::DEPS)

add_executable(hbmoonlight
  src/main.c src/args.c src/session.c src/video.c src/audio.c src/input.c)
target_compile_options(hbmoonlight PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(hbmoonlight PRIVATE gamestream Threads::Threads)

# The helper tests live in the sibling moonlight-nx2-dev repo; DEV_DIR points elsewhere.
get_filename_component(DEFAULT_DEV_DIR
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../../moonlight-nx2-dev/src/streamer/protocol/test" ABSOLUTE)
set(DEV_DIR "${DEFAULT_DEV_DIR}" CACHE PATH "helper test directory")
set(HAVE_DEV EXISTS "${DEV_DIR}/input.c")

include(CTest)
if(BUILD_TESTING AND NOT ${HAVE_DEV})
  message(WARNING "No helper tests in ${DEV_DIR}: set DEV_DIR to moonlight-nx2-dev/src/streamer/protocol/test")
endif()
if(BUILD_TESTING AND ${HAVE_DEV})
  add_executable(hbmoonlight-input-check ${DEV_DIR}/input.c src/input.c)
  target_include_directories(hbmoonlight-input-check PRIVATE src ${UPSTREAM_DIR}/moonlight-common-c/src)
  target_compile_options(hbmoonlight-input-check PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
  add_test(NAME input-routing COMMAND hbmoonlight-input-check)

  add_executable(hbmoonlight-apps-check ${DEV_DIR}/apps.c src/session.c)
  target_include_directories(hbmoonlight-apps-check PRIVATE src)
  target_compile_options(hbmoonlight-apps-check PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
  target_link_libraries(hbmoonlight-apps-check PRIVATE gamestream Threads::Threads)
  add_test(NAME app-order COMMAND hbmoonlight-apps-check)

  add_executable(hbmoonlight-args-check ${DEV_DIR}/args.c src/args.c)
  target_include_directories(hbmoonlight-args-check PRIVATE src ${UPSTREAM_DIR}/moonlight-common-c/src)
  target_compile_options(hbmoonlight-args-check PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
  add_test(NAME stream-codec COMMAND hbmoonlight-args-check)

  if(EXISTS "${DEV_DIR}/video-codec.c")
    add_executable(hbmoonlight-video-codec-check ${DEV_DIR}/video-codec.c src/video.c)
    target_include_directories(hbmoonlight-video-codec-check PRIVATE src)
    target_compile_options(hbmoonlight-video-codec-check PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
    target_link_libraries(hbmoonlight-video-codec-check PRIVATE moonlight-common-c Threads::Threads)
    add_test(NAME negotiated-codec COMMAND hbmoonlight-video-codec-check)
  endif()
endif()

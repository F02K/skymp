project(skymp5-gamemode-compiler)

if(WIN32)
  find_program(GAMEMODE_COMPILER_NPM_EXECUTABLE NAMES npm.cmd REQUIRED)
else()
  find_program(GAMEMODE_COMPILER_NPM_EXECUTABLE NAMES npm REQUIRED)
endif()
file(GLOB_RECURSE sources CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_LIST_DIR}/src/*.ts
  ${CMAKE_CURRENT_LIST_DIR}/types/*.d.ts
  ${CMAKE_CURRENT_LIST_DIR}/test/*.js
)

set(dependency_stamp ${CMAKE_CURRENT_BINARY_DIR}/npm-dependencies.stamp)
add_custom_command(
  OUTPUT ${dependency_stamp}
  COMMAND ${CMAKE_COMMAND} -E env -- ${GAMEMODE_COMPILER_NPM_EXECUTABLE} ci
  COMMAND ${CMAKE_COMMAND} -E touch ${dependency_stamp}
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  DEPENDS ${CMAKE_CURRENT_LIST_DIR}/package.json ${CMAKE_CURRENT_LIST_DIR}/package-lock.json
  COMMENT "Installing gamemode compiler dependencies"
)

set(compiler_output ${CMAKE_CURRENT_LIST_DIR}/dist/cli.js)
add_custom_command(
  OUTPUT ${compiler_output}
  COMMAND ${CMAKE_COMMAND} -E env -- ${GAMEMODE_COMPILER_NPM_EXECUTABLE} run build
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  DEPENDS ${sources} ${dependency_stamp}
  COMMENT "Building gamemode compiler"
)

add_custom_target(skymp5-gamemode-compiler ALL
  DEPENDS ${compiler_output}
  SOURCES ${sources}
)

if(BUILD_UNIT_TESTS)
  add_test(
    NAME gamemode_compiler
    COMMAND ${CMAKE_COMMAND} -E env -- ${GAMEMODE_COMPILER_NPM_EXECUTABLE} test
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  )
endif()

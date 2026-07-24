project(skymp-backend)

if(NOT BUILD_MANAGED_BACKEND)
  add_custom_target(skymp-backend
    COMMAND ${CMAKE_COMMAND} -E echo "Building skymp-backend is disabled. Set BUILD_MANAGED_BACKEND to ON to enable it."
  )
  add_custom_target(skymp-managed-server
    COMMAND ${CMAKE_COMMAND} -E echo "Packaging the managed server is disabled. Set BUILD_MANAGED_BACKEND to ON to enable it."
  )
  return()
endif()

if(EMSCRIPTEN)
  message(FATAL_ERROR "BUILD_MANAGED_BACKEND is not supported on Emscripten")
endif()

if(WIN32)
  find_program(SKYMP_BACKEND_NPM_EXECUTABLE NAMES npm.cmd REQUIRED)
  find_program(SKYMP_BACKEND_NODE_EXECUTABLE NAMES node.exe node REQUIRED)
else()
  find_program(SKYMP_BACKEND_NPM_EXECUTABLE NAMES npm REQUIRED)
  find_program(SKYMP_BACKEND_NODE_EXECUTABLE NAMES node REQUIRED)
endif()

execute_process(
  COMMAND ${SKYMP_BACKEND_NODE_EXECUTABLE} --version
  OUTPUT_VARIABLE SKYMP_BACKEND_NODE_VERSION
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REGEX REPLACE "^v" "" SKYMP_BACKEND_NODE_VERSION "${SKYMP_BACKEND_NODE_VERSION}")
if(SKYMP_BACKEND_NODE_VERSION VERSION_LESS "22.0.0")
  message(FATAL_ERROR "skymp-backend requires Node.js 22 or newer, found ${SKYMP_BACKEND_NODE_VERSION}")
endif()

file(GLOB_RECURSE backend_sources CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_LIST_DIR}/src/*.ts
)
file(GLOB_RECURSE backend_tests CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_LIST_DIR}/test/*.mjs
)

set(backend_dependency_stamp ${CMAKE_CURRENT_BINARY_DIR}/npm-dependencies.stamp)
add_custom_command(
  OUTPUT ${backend_dependency_stamp}
  COMMAND ${CMAKE_COMMAND} -E env -- ${SKYMP_BACKEND_NPM_EXECUTABLE} ci
  COMMAND ${CMAKE_COMMAND} -E touch ${backend_dependency_stamp}
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  DEPENDS ${CMAKE_CURRENT_LIST_DIR}/package.json ${CMAKE_CURRENT_LIST_DIR}/package-lock.json
  COMMENT "Installing managed backend dependencies"
)

set(backend_output ${CMAKE_CURRENT_LIST_DIR}/dist/main.js)
add_custom_command(
  OUTPUT ${backend_output}
  COMMAND ${CMAKE_COMMAND} -E env -- ${SKYMP_BACKEND_NPM_EXECUTABLE} run build
  WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  DEPENDS
    ${backend_sources}
    ${backend_dependency_stamp}
    ${CMAKE_CURRENT_LIST_DIR}/tsconfig.json
  COMMENT "Building managed backend"
)

add_custom_target(skymp-backend ALL
  DEPENDS ${backend_output}
  SOURCES ${backend_sources} ${backend_tests}
)

set(managed_server_package_stamp ${CMAKE_CURRENT_BINARY_DIR}/managed-server-package.stamp)
add_custom_command(
  OUTPUT ${managed_server_package_stamp}
  COMMAND ${SKYMP_BACKEND_NODE_EXECUTABLE} ${CMAKE_SOURCE_DIR}/scripts/package-managed-server.mjs --skip-build
  COMMAND ${CMAKE_COMMAND} -E touch ${managed_server_package_stamp}
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  DEPENDS
    ${backend_output}
    ${CMAKE_SOURCE_DIR}/scripts/package-managed-server.mjs
    ${CMAKE_CURRENT_LIST_DIR}/backend.config.example.json
    ${CMAKE_CURRENT_LIST_DIR}/backend.config.schema.json
    ${CMAKE_CURRENT_LIST_DIR}/modules.lock.json
    ${CMAKE_CURRENT_LIST_DIR}/package.json
  COMMENT "Packaging managed SkyMP server"
)

add_custom_target(skymp-managed-server ALL
  DEPENDS ${managed_server_package_stamp}
)
add_dependencies(skymp-managed-server skymp-backend skymp5-server)

if(BUILD_UNIT_TESTS)
  add_test(
    NAME skymp_backend
    COMMAND ${CMAKE_COMMAND} -E env -- ${SKYMP_BACKEND_NPM_EXECUTABLE} test
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  )
endif()

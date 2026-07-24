project(skymp-buildtool NONE)

find_program(SKYMP_BUILDTOOL_NODE_EXECUTABLE NAMES node.exe node REQUIRED)
file(GLOB_RECURSE buildtool_sources CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_LIST_DIR}/src/*.mjs
  ${CMAKE_CURRENT_LIST_DIR}/test/*.test.mjs
)

add_custom_target(skymp-buildtool
  COMMAND ${SKYMP_BUILDTOOL_NODE_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/cli.mjs --help
  SOURCES ${buildtool_sources} ${CMAKE_CURRENT_LIST_DIR}/cli.mjs
)

if(BUILD_UNIT_TESTS)
  file(GLOB buildtool_tests CONFIGURE_DEPENDS ${CMAKE_CURRENT_LIST_DIR}/test/*.test.mjs)
  add_test(
    NAME skymp_buildtool
    COMMAND ${SKYMP_BUILDTOOL_NODE_EXECUTABLE} --test ${buildtool_tests}
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
  )
endif()

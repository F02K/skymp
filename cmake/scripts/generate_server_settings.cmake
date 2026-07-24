# Usage: "cmake -P generate_server_settings.cmake -DESM_PREFIX=<prefix_here> -DSERVER_SETTINGS_JSON_PATH=<path_to_server_settings.json> -DOFFLINE_MODE=<true_or_false>"

# Keep a non-packaged authoritative base for direct-server builds and
# integration tests. Managed packaging may intentionally sanitize the copy
# inside dist/server, which must not feed back into later CMake builds.
if(SERVER_SETTINGS_BASE_JSON_PATH AND EXISTS "${SERVER_SETTINGS_BASE_JSON_PATH}")
    file(READ "${SERVER_SETTINGS_BASE_JSON_PATH}" SERVER_SETTINGS_JSON)
elseif(EXISTS "${SERVER_SETTINGS_JSON_PATH}")
    file(READ "${SERVER_SETTINGS_JSON_PATH}" SERVER_SETTINGS_JSON)
else()
    set(SERVER_SETTINGS_JSON "{}")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "dataDir" "\"data\"")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "name" "\"My Server\"")
    set(load_order Skyrim.esm Update.esm Dawnguard.esm HearthFires.esm Dragonborn.esm)
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "loadOrder" "[0,0,0,0,0]")
    foreach(index RANGE 0 4)
        list(GET load_order ${index} ESM)
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "loadOrder" ${index} "\"${ESM_PREFIX}${ESM}\"")
    endforeach()
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "npcEnabled" "false")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "port" "7777")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "maxPlayers" "100")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "npcSettings" "{}")
endif()

if(OFFLINE_MODE)
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "offlineMode" "true")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "master" "\"\"")
else()
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "offlineMode" "false")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "master" "\"https://gateway.skymp.net\"")
endif()

file(WRITE "${SERVER_SETTINGS_JSON_PATH}" "${SERVER_SETTINGS_JSON}")

if(SERVER_SETTINGS_BASE_JSON_PATH)
  file(WRITE "${SERVER_SETTINGS_BASE_JSON_PATH}" "${SERVER_SETTINGS_JSON}")
endif()

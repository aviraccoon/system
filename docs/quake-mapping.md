# Quake Mapping Setup

How to set up TrenchBroom, ericw-tools, and vkQuake for editing and playing Quake maps. All software is already installed via Nix -- this covers first-time configuration.

## Installed tools

| Tool | Purpose | Source |
|------|---------|--------|
| TrenchBroom | Map editor | `packages/trenchbroom.nix` |
| ericw-tools (`qbsp`, `vis`, `light`) | Map compiler | `packages/ericw-tools.nix` |
| vkQuake | Quake engine (Vulkan, native ARM) | `packages/vkquake.nix` |
| LibreQuake | Free game data (replaces Quake shareware) | `packages/librequake.nix` |

Game data is symlinked to `~/.quakespasm/id1` (read-only, from Nix store).
Custom maps go in `~/.quakespasm/custom/maps/` (writable, created by Home Manager activation).

## 1. Configure TrenchBroom

### Set the game path

On first launch, TrenchBroom asks for the Quake game path.

- **Game**: Quake
- **Game path**: `~/.quakespasm`

This directory contains `id1/` with LibreQuake's `pak0.pak` and `pak1.pak`.

### Configure the engine

Open **Preferences** and click **Configure engines...**

1. Click **+** to add an engine
2. Name it `vkQuake`
3. Browse to `~/Applications/vkQuake.app`

### Set up a compile profile

Open **Run > Compile Map...**

1. Click **+** to create a new profile (e.g. "Default")
2. Set **Working Directory** to `${MAP_DIR_PATH}`
3. Add these tasks in order:

| # | Type | Settings |
|---|------|----------|
| 1 | Export Map | Target: `${WORK_DIR_PATH}/${MAP_BASE_NAME}-compile.map` |
| 2 | Run Tool | Tool: `qbsp` — Parameters: `${MAP_BASE_NAME}-compile.map ${MAP_BASE_NAME}.bsp` |
| 3 | Run Tool | Tool: `vis` — Parameters: `${MAP_BASE_NAME}.bsp` |
| 4 | Run Tool | Tool: `light` — Parameters: `${MAP_BASE_NAME}.bsp` |
| 5 | Copy Files | Source: `${WORK_DIR_PATH}/${MAP_BASE_NAME}.bsp` — Target: `${GAME_DIR_PATH}/custom/maps` |

For the tool paths, find them with `which qbsp`, `which vis`, `which light`.

For release-quality lighting, use `-soft -extra4 ${MAP_BASE_NAME}.bsp` as the light parameters. Flags must come **before** the filename.

### Set up engine launch

Open **Run > Launch Engine...**

1. Select the `vkQuake` engine
2. Set **Parameters** to: `-basedir ${GAME_DIR_PATH} -game custom +map ${MAP_BASE_NAME}`

## 2. Edit, compile, play

1. **Edit** your map in TrenchBroom
2. **Compile** with Run > Compile Map (or the compile shortcut)
3. **Play** with Run > Launch Engine

## Notes

- The `.lit` copy step is optional. Only needed if you use colored lighting (`-lit` flag to `light`). Most maps won't produce one.
- Texture warnings like "unable to find texture X" during compile are normal if the map references textures not in LibreQuake's pak files. The geometry still works.
- WAD warnings ("Could not load wad file") mean the map references an external texture WAD. You'd need to find that WAD or retexture using LibreQuake's built-in textures.
- Don't launch vkQuake via a "Run Tool" compile step -- SDL2 apps render a black window when launched that way. Always use **Run > Launch Engine**.
- `~/.quakespasm/id1` is a symlink to the Nix store (read-only). Custom maps must go in `~/.quakespasm/custom/maps/`, which is why the compile profile copies there and the engine launches with `-game custom`.

## Using maps in Godot with FuncGodot

[FuncGodot](https://github.com/func-godot/func_godot_plugin) is a Godot 4 plugin that imports Quake `.map` files directly into Godot scenes -- meshes, collision shapes, UVs, entities, the works. It's designed to pair with TrenchBroom.

The workflow: design levels in TrenchBroom, import them into Godot via FuncGodot. This gives you a fast iteration loop using TrenchBroom's brush-based editing with Godot's runtime and scripting.

FuncGodot is a per-project Godot addon, not a system package. Install it via the Godot Asset Library or by copying the `addons/func_godot` folder into your project. See the [FuncGodot documentation](https://func-godot.github.io/func_godot_docs/) for setup.

Godot is installed via `packages/godot.nix` (in `~/Applications/`).

## TrenchBroom variables reference

| Variable | Meaning |
|----------|---------|
| `${MAP_BASE_NAME}` | Map filename without extension |
| `${MAP_DIR_PATH}` | Directory containing the .map file |
| `${WORK_DIR_PATH}` | Working directory (set per profile) |
| `${GAME_DIR_PATH}` | Game path from TrenchBroom preferences |
| `${MODS[-1]}` | Last mod directory in the mod list |

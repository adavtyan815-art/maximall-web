# Golden Rule for UE5C++

This document defines the core workflow, file mirroring rules, GitHub push protocols, and cross-project integration guidelines for Unreal Engine 5 C++ development.

---

## 1. Project Workflow & Directory Structure

* **Local Test Project (`MaxiMall`)**:
  - **Path**: `C:\Users\Admin\Desktop\Aleg\UE5C++\MaxiMall\Source\MaxiMall\`
  - **Function**: This is the local C++ project opened in Unreal Editor on the local computer to write, test, and validate UE5 C++ code and Blueprints.
* **Staging Source Directory (`Source`)**:
  - **Path**: `C:\Users\Admin\Desktop\Aleg\UE5C++\Source\`
  - **Function**: Contains the staged C++ source files intended for the main remote project named `awsTutorial` on another computer.

---

## 2. File Mirroring & API Translation Rules

1. **100% Structural Parity**:
   All files in `C:\Users\Admin\Desktop\Aleg\UE5C++\Source\` must be **100% identical** in structure, logic, and functionality to the files in `C:\Users\Admin\Desktop\Aleg\UE5C++\MaxiMall\Source\MaxiMall\`.
2. **API Macro & Header Translation**:
   The only permitted differences between `MaxiMall` and `Source` (`awsTutorial`) are module API macros and header includes:
   * **Module Macro**: `MAXIMALL_API` (in `MaxiMall`) $\longleftrightarrow$ `AWSTUTORIAL_API` (in `Source`/`awsTutorial`)
   * **Primary Module Header**: `#include "MaxiMall.h"` $\longleftrightarrow$ `#include "awsTutorial.h"`
   * **Class Names & Headers**: `#include "MaxiMall_PlayerController.h"` $\longleftrightarrow$ `#include "awsTutorial_PlayerController.h"`, `AMaxiMall_PlayerController` $\longleftrightarrow$ `AAwsTutorial_PlayerController`

---

## 3. Manual Transfer Protocol

1. **Local Validation**: Code is developed and tested 100% successfully inside `MaxiMall` in Unreal Editor.
2. **Staging**: Upon 100% positive test results, the mirrored, API-translated files are updated in `C:\Users\Admin\Desktop\Aleg\UE5C++\Source\`.
3. **Manual Transfer**: The agent **NEVER** modifies or uploads files directly to the remote `awsTutorial` computer. The USER manually transfers the verified files from `Source` to the remote computer for `awsTutorial`.

---

## 4. GitHub Branching & Push Protocol

The agent has full permissions for the `UE5C++` GitHub repository. Pushing code must strictly follow these rules:

1. **`dev` Branch**: The agent pushes code to `dev` **ONLY** after explicit approval from the USER.
2. **`main` Branch**: The agent pushes code to `main` **ONLY** when the USER explicitly states: *"add this final state to main"*.

---

## 5. Interconnection of the 3 Projects & Conflict Elimination

The overall system is made up of 3 connected components:
1. **Web (`maximall-web`)**: Provides user connections, turns EC2 instances on/off, tracks session time, and manages buffers.
2. **Pixel Config (`maximall-pixel-config`)**: The Pixel Streaming configuration layer (`player.html`, `player.js`, signaling server) that streams video/input between browser and server.
3. **UE5 Project (`UE5C++`)**: The game/software logic—the actual `.exe` application running on the server.

### **Cross-Impact Rule for UE5 C++**:
When writing or modifying C++ code in `UE5C++`, the agent must evaluate how independent that code is and how much impact it has on the Web and Pixel Config projects. If an impact exists (e.g. Slate UI input handling or level loading times), the code must be written to eliminate any possible cross-project conflicts.

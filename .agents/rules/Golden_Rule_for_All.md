# Golden Rule for All Projects

This document defines the master architectural structure, project roles, deployment protocols, GitHub branching rules, and cross-project conflict elimination guidelines across all 3 interconnected projects.

---

## 1. The 3 Interconnected Projects & Their Roles

The platform relies on 3 connected projects working in harmony:

1. **Web (`maximall-web`)** — *Path*: `C:\Users\Admin\Desktop\Aleg\maximall-web`
   - **Role**: Provides user connections, handles turning AWS EC2 instances on/off, tracks session time quotas, manages pre-warmed buffer pools, and hosts the admin dashboard.
2. **Pixel Config (`maximall-pixel-config`)** — *Path*: `C:\Users\Admin\Desktop\Aleg\maximall-pixel-config`
   - **Role**: The Pixel Streaming configuration layer (`player.html`, `player.js`, signaling server) that handles WebRTC video streaming and input transmission between the browser and the server.
3. **UE5 Project (`UE5C++`)** — *Path*: `C:\Users\Admin\Desktop\Aleg\UE5C++`
   - **Role**: Contains the game/software logic—the actual 3D `.exe` application running on the AWS EC2 instance.
   - **Workflow**: Developed and tested locally in `MaxiMall` (`Source/MaxiMall/`), staged in `Source/`, and transferred **manually by the USER** to the remote computer running `awsTutorial`.

---

## 2. GitHub Branching & Permission Protocol

The agent has full permissions for the GitHub repositories of all 3 projects. Pushing code must strictly follow these rules:

1. **Dedicated Repositories**: Each of the 3 projects has its own separate GitHub repository containing `main` and `dev` branches.
2. **`dev` Branch**: The agent pushes code to `dev` **ONLY** after receiving explicit approval from the USER.
3. **`main` Branch**: The agent pushes code to `main` **ONLY** when the USER explicitly states: *"add this final state to main"*.

---

## 3. Deployment & Manual Transfer Protocols

1. **`maximall-web` (Web Orchestrator)**:
   - Deployed and updated on the AWS server by the agent **ONLY** after explicit approval from the USER.
2. **`UE5C++` & `maximall-pixel-config`**:
   - The agent **NEVER** uploads files directly to the remote `awsTutorial` computer or to the AWS EC2 instance AMI.
   - The agent provides clear instructions on what files to copy or upload, and the USER performs the transfer manually.

---

## 4. Cross-Project Conflict Elimination Rule

* Whenever writing or modifying code in ANY of the 3 projects (`UE5C++`, `maximall-web`, or `maximall-pixel-config`), the agent must evaluate:
  - How independent is this code?
  - What impact will this code have on the other 2 projects?
* If an impact exists (e.g. Slate UI input events in UE5 C++ affecting WebSockets in Pixel Config, or EC2 polling timeouts in Web affecting user connections), the code must be designed and written to **eliminate any possible cross-project conflicts**.

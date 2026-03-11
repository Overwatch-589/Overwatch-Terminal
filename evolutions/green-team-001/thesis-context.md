# Thesis Context: Municipal Water Distribution Network

## System Overview
The monitored entity is the SCADA (Supervisory Control and Data Acquisition) telemetry system for Regional Water Distribution Grid, Sector 4. The system is responsible for maintaining potable water pressure and flow to a dense municipal and industrial zone. It utilizes a combination of active primary electric pump stations and passive, high-elevation gravity-fed reserve tanks. The system is operated by municipal water engineers and automated logic controllers.

## Core Thesis
The distribution grid maintains structural integrity, prevents contamination, and sustains viable flow under extreme asymmetric load through automated redundancy, fail-safe equipment protection, and gravity-fed reserve deployment. The system's architecture is resilient enough to sacrifice primary active components to protect the whole, relying on passive reserves to maintain baseline viability.

## Key Indicators
* **Sector 4 Pressure (PSI):** The localized pressure at the point of highest demand. Must remain above 20 PSI to prevent groundwater infiltration and boiling advisories.
* **System Total Flow (GPM):** The aggregate volume of water moving through the network.
* **Primary Pump Load & Cavitation:** Indicates the strain on the active mechanical water supply. Cavitation occurs when demand outpaces supply water, creating destructive vacuums inside the pumps.
* **Surge Relief Valve Status:** A mechanical safety bypass designed to dump water out of the high-pressure mains into a holding basin to prevent shockwaves (water hammer) if a pump suddenly stops.
* **Gravity Reserve Level:** The percentage of water remaining in the high-elevation backup tanks, which flow passively based on physics (head pressure) when grid pressure drops below the tanks' static pressure.

## Falsification Criteria (Kill Switches)
The thesis of system viability is falsified, and emergency shutdown/isolation is required, if any of the following conditions are met:
1.  **System-Wide Pressure Collapse:** `grid_average_pressure_psi` drops below 25.0 PSI for consecutive readings.
2.  **Critical Contamination Risk:** `sector_4_pressure_psi` drops below 20.0 PSI (State minimum safe operating threshold).
3.  **Catastrophic Uncontained Leak:** `system_total_flow_gpm` exceeds 20,000 GPM *while* `high_zone_gravity_reserve_level_pct` is dropping by more than 15% per minute and pumps are active.
4.  **Reserve Depletion During Outage:** `high_zone_gravity_reserve_level_pct` drops below 10.0% while primary pumps remain offline.
5.  **Destructive Mechanical Failure:** `pump_cavitation_acoustic_sensor` registers "CRITICAL_DAMAGE" or fails to trip the pump offline during a sustained "WARNING_ELEVATED" state.

## Key Entities
* **SCADA Automated Logic:** Programmed to protect the physical infrastructure first. It will ruthlessly shut down expensive pumps to save them from cavitation, even if it causes a temporary pressure plunge.
* **Grid Operators:** Monitor the automated systems. Their primary stated protocol during an acute draw (like a multi-alarm fire) is to allow the automated failovers to work, verify gravity reserves are deploying, and prepare to isolate the sector only if pressure approaches 20 PSI.
* **Demand Source:** External actors (e.g., Fire Department apparatus) capable of pulling negative pressure on the hydrants, forcing the grid to adapt to a sudden, massive change in fluid dynamics.

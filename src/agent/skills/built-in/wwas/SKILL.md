---
name: wwas
description: Create product backlog items in Why-What-Acceptance format — independent, valuable, testable items with strategic context. Use when writing structured backlog items, breaking features into work items, or using the WWA format.
---

# Why-What-Acceptance (WWA) Framework

This skill teaches you how to structure tasks, user stories, and product requirements using the **Why-What-Acceptance** format. 
This is the preferred format for AILoop to define tasks, as it provides clear strategic alignment, concrete deliverables, and verifiable success criteria.

## Core Structure

Every task or requirement MUST contain these three sections:

### 1. WHY (Strategic Context & Value)
*   **Purpose:** Explain the business value, user benefit, or technical necessity of this work.
*   **Key Question:** If we don't do this, what happens? Why is this the most important thing to do right now?
*   **Format:** A brief paragraph or a few bullet points.

### 2. WHAT (Deliverables & Scope)
*   **Purpose:** Define exactly what needs to be built, changed, or researched.
*   **Key Question:** What does the end state look like? 
*   **Format:** Clear, actionable statements. Define constraints (what NOT to do) if scope creep is a risk.

### 3. ACCEPTANCE (Verification Criteria)
*   **Purpose:** Provide unambiguous, testable conditions that prove the "What" has been achieved.
*   **Key Question:** How will the Evaluator or QA know this is done and working?
*   **Format:** A numbered or bulleted checklist of testable facts (e.g., "Given X, when Y, then Z", or "Command X exits with code 0").

## Example

**Title:** Implement Redis Caching for User Profiles

**WHY:** 
The database is currently hitting 90% CPU load during peak hours due to repeated profile fetches. Caching these reads in Redis will reduce DB load, decrease API latency from 200ms to <50ms, and improve user experience.

**WHAT:**
*   Integrate `ioredis` into the `UserProfileService`.
*   Cache the output of `getUserProfile(id)` with a TTL of 5 minutes.
*   Invalidate the cache automatically when `updateUserProfile(id, data)` is called.
*   *Out of scope:* Do not cache other entities (like Posts or Comments) in this task.

**ACCEPTANCE:**
1.  Unit tests mock Redis and verify `getUserProfile` calls `redis.get` before hitting the DB.
2.  Integration test proves that updating a profile clears the corresponding Redis key.
3.  Load testing script shows API response under 50ms for cached profiles.

## Instructions for Project Planner and Product Manager
When the Product Manager is shaping a requirement slice or the Project Planner is deriving the next round from that slice, use the WWA framework internally.
This keeps the requirement and the round task aligned on *why* the work matters, *what* the intended end state is, and how the Evaluator will verify *acceptance*.

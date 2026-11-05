import { world, system, Vector3 } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const NEMETRIX_ID = "nem:nemetrix";
const TRANSFORMED_TAG = "nem:transformed";
const PREDATOR_FORM_TAG = "nem:predator_form";

const PREDATORS = [
  { id: "nem:tyrannopede", name: "Tyrannopede", prey: "Wildmutt" },
  { id: "nem:mucilator", name: "Mucilator", prey: "Stinkfly" },
  { id: "nem:hypnotick", name: "Hypnotick", prey: "Ditto" },
  { id: "nem:crabdozer", name: "Crabdozer", prey: "Four Arms" },
  { id: "nem:terroranchula", name: "Terroranchula", prey: "Spidermonkey" }
];

const SEARCH_RADIUS = 5;

/**
 * Find a tame wolf or a transformed predator belonging to the given player.
 * Prefers the nearest one around the player.
 * @param {import("@minecraft/server").Player} player
 * @returns {{ entity, kind: "dog"|"predator" }|null}
 */
function findTarget(player) {
  const dim = player.dimension;
  const pos = player.location;
  const radius = SEARCH_RADIUS;

  // Search for tame wolves owned by the player.
  const wolfQuery = {
    type: "minecraft:wolf",
    location: pos,
    maxDistance: radius
  };
  const wolves = dim.getEntities(wolfQuery);
  let nearestWolf = null;
  let nearestWolfDist = Infinity;
  for (const w of wolves) {
    const tamedComp = w.getComponent("minecraft:is_tamed");
    if (!tamedComp || !tamedComp.isTamed) continue;
    const ownerId = tamedComp.tamedByPlayerId ?? "";
    if (ownerId && ownerId !== player.id) continue;
    const d = Vector3.distance(w.location, pos);
    if (d < nearestWolfDist) {
      nearestWolfDist = d;
      nearestWolf = w;
    }
  }
  if (nearestWolf) return { entity: nearestWolf, kind: "dog" };

  // Search for a transformed predator near the player (owned by the player).
  const predQuery = {
    families: ["nem_predator"],
    location: pos,
    maxDistance: radius
  };
  const predators = dim.getEntities(predQuery);
  let nearestPred = null;
  let nearestPredDist = Infinity;
  for (const p of predators) {
    if (!p.hasTag(TRANSFORMED_TAG)) continue;
    if (p.getDynamicProperty("nemOwner") !== player.id) continue;
    const d = Vector3.distance(p.location, pos);
    if (d < nearestPredDist) {
      nearestPredDist = d;
      nearestPred = p;
    }
  }
  if (nearestPred) return { entity: nearestPred, kind: "predator" };

  return null;
}

/**
 * Record the dog's identity on the predator so it can be restored later.
 * @param {import("@minecraft/server").Entity} dog
 * @param {import("@minecraft/server").Player} player
 * @param {string} predatorId
 */
function transformDog(dog, player, predatorId) {
  const dim = dog.dimension;
  const pos = dog.location;
  const name = dog.nameTag || "";

  // Remove the dog.
  dog.remove();

  // Summon the predator in its place.
  const pred = dim.spawnEntity(predatorId, pos);
  pred.addTag(TRANSFORMED_TAG);
  pred.addTag(PREDATOR_FORM_TAG + "_" + predatorId);
  pred.setDynamicProperty("nemOwner", player.id);
  pred.setDynamicProperty("nemDogName", name);
  if (name) pred.nameTag = name;

  // If the player is riding... nothing, but make the predator follow the owner.
  // Tameable predators: set the wolf tameable-like follow by re-parenting.
  const predatorTameable = pred.getComponent("minecraft:tameable");
  if (predatorTameable && typeof predatorTameable.tame === "function") {
    try {
      predatorTameable.tame(player);
    } catch (e) {
      // ignore
    }
  }

  dim.playSound("mob.enderdragon.growl", pos);

  // Tell the player what happened.
  const form = PREDATORS.find((p) => p.id === predatorId);
  player.sendMessage(
    `§2[Nemetrix] §fYour dog has transformed into §a${form.name}§f, the predator of §e${form.prey}§f!`
  );
}

/**
 * Restore a dog from a transformed predator.
 * @param {import("@minecraft/server").Entity} predator
 * @param {import("@minecraft/server").Player} player
 */
function revertPredator(predator, player) {
  const dim = predator.dimension;
  const pos = predator.location;
  const name = predator.getDynamicProperty("nemDogName") || "";
  const ownerId = predator.getDynamicProperty("nemOwner");

  predator.remove();

  const dog = dim.spawnEntity("minecraft:wolf", pos);
  if (name) dog.nameTag = name;

  // Re-tame the dog to the original owner.
  if (ownerId) {
    const owner = world.getEntity(ownerId);
    if (owner) {
      const tameable = dog.getComponent("minecraft:tameable");
      if (tameable && typeof tameable.tame === "function") {
        try {
          tameable.tame(owner);
        } catch (e) {
          dog.setDynamicProperty("nemOwner", ownerId);
        }
      }
    }
  }

  dim.playSound("mob.cat.purr", pos);
  player.sendMessage(
    `§2[Nemetrix] §fYour dog has reverted back to its normal form!`
  );
}

/**
 * Open the predator selection UI.
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity} dog
 */
async function openFormSelection(player, dog) {
  const form = new ActionFormData();
  form.title("§2Nemetrix Device");
  form.body(
    `§7Select a predator form for your tame dog.\n\n` +
      `§eCurrent target: §f${dog.nameTag ? dog.nameTag : "your dog"}\n` +
      `§7Choose a form to transform it into.`
  );
  form.button(`§aTyrannopede\n§7Prey: Wildmutt`);
  form.button(`§aMucilator\n§7Prey: Stinkfly`);
  form.button(`§aHypnotick\n§7Prey: Ditto`);
  form.button(`§aCrabdozer\n§7Prey: Four Arms`);
  form.button(`§aTerroranchula\n§7Prey: Spidermonkey`);
  form.button("§cCancel");

  const response = await form.show(player);
  if (response.canceled) return;
  if (response.selection === undefined) return;

  const index = response.selection;
  if (index === PREDATORS.length) return; // Cancel pressed
  const chosen = PREDATORS[index];
  transformDog(dog, player, chosen.id);
}

/**
 * Main interaction handler when the Nemetrix is used.
 * @param {import("@minecraft/server").Player} player
 */
function handleUse(player) {
  const target = findTarget(player);
  if (!target) {
    player.sendMessage(
      `§2[Nemetrix] §cNo tame dog or transformed predator nearby! §7Get within ${
        SEARCH_RADIUS
      } blocks of your tame dog.`
    );
    return;
  }

  if (target.kind === "predator") {
    revertPredator(target.entity, player);
  } else {
    openFormSelection(player, target.entity);
  }
}

// Subscribe to Nemetrix item use. We use beforeEvents to cancel eating.
world.beforeEvents.itemUse.subscribe((event) => {
  const item = event.itemStack;
  if (!item || item.typeId !== NEMETRIX_ID) return;
  const player = event.source;
  if (!player || !player.typeId || player.typeId !== "minecraft:player") return;
  event.cancel = true;
  handleUse(player);
});

world.afterEvents.worldLoad.subscribe(() => {
  console.warn("[Nemetrix] Addon loaded. Use the Nemetrix device to select a predator form for your tame dog.");
});

export const actions = Object.create(null);

export function configureActions(next) {
  Object.assign(actions, next);
}

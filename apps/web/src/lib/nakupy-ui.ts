export interface NakupySeedAction {
  label: 'Sestavit nákupní seznam' | 'Doplnit seznam';
  variant: 'primary' | 'secondary';
}

/** Nad existujícím seznamem ponechá menší sekundární akci pro opakovaný seed. */
export function nakupySeedAction(itemCount: number): NakupySeedAction {
  return itemCount > 0
    ? { label: 'Doplnit seznam', variant: 'secondary' }
    : { label: 'Sestavit nákupní seznam', variant: 'primary' };
}

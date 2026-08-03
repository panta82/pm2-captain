import { createContext, useContext } from 'react';

export type IProcessListFilter = {
  search: string;
  caseSensitive: boolean;
  regex: boolean;
};

const ProcessListFilterContext = createContext<IProcessListFilter>({
  search: '',
  caseSensitive: false,
  regex: false,
});

export function ProcessListFilterProvider({
  value,
  children,
}: {
  value: IProcessListFilter;
  children: React.ReactNode;
}) {
  return (
    <ProcessListFilterContext.Provider value={value}>{children}</ProcessListFilterContext.Provider>
  );
}

export function useProcessListFilter(): IProcessListFilter {
  return useContext(ProcessListFilterContext);
}

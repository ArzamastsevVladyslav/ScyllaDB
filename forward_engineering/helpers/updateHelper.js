const { getTypeByData } = require('./typeHelper');
const { getTableNameStatement, commentDeactivatedStatement, getApplyDropStatement, tab } = require('./generalHelper');
const { getTableStatement, mergeValuesWithConfigOptions } = require('./tableHelper');
const { getDiff } = require('./tableOptionService/getDiff');
const { parseToString } = require('./tableOptionService/parseToString');
const { dependencies } = require('./appDependencies');
const { getKeySpaceScript } = require('./updateHelpers/keySpaceHelper');
const { mergeArrays, checkIsOldModel, fieldTypeCompatible } = require('./updateHelpers/generalHelper');
const { getViewScript } = require('./updateHelpers/viewHelper');
const { getIndexTable } = require('./updateHelpers/indexHelper');
const { getUdtScript, sortAddedUdt } = require('./updateHelpers/udtHelper');
const { alterTablePrefix, getDelete } = require('./updateHelpers/tableHelper');

let _;

const setDependencies = ({ lodash }) => _ = lodash;

const getUpdateType = updateTypeData => 
	`${alterTablePrefix(updateTypeData.tableName, updateTypeData.keySpace)} 
	ALTER "${updateTypeData.columnData.name}" TYPE ${updateTypeData.columnData.type};`;

const addColumnStatement = columnData => `ADD "${columnData.name}" ${columnData.type}`;

const getAdd = addData => {
	const script = `${alterTablePrefix(addData.tableName, addData.keyspaceName)} ${addColumnStatement(addData.columnData)};`;
	return [{
		deleted: false,
		modified: false,
		added: true,
		script,
		field: 'field',
	}];
};

const objectContainsProp = (object, key) => object[key] ? true : false;

const isCommentNew = comment => comment && comment.new && comment.new !== comment.old;
const getChangeOption = ({ options, comment }) => {
	const optionsDiff = getDiff(options.new || {}, options.old || {});
	const configOptionsWithValues = mergeValuesWithConfigOptions(optionsDiff);
	return isCommentNew(comment)
		? parseToString(configOptionsWithValues, comment.new)
		: parseToString(configOptionsWithValues);
};

const getCollectionName = compMod => {
	const { collectionName = {}, code = {} } = compMod;
	return {
		oldName: code.old || collectionName.old,
		newName: code.new || collectionName.new,
	}
}

const getUpdate = updateData => {
	const property = updateData.property;
	const oldName = _.get(property, 'compMod.oldField.name');
	const newName = _.get(property, 'compMod.newField.name');
	const getData = columnData => ({ ...updateData, columnData: { ...updateData.columnData, ...columnData }});
	if (!oldName || 
		!newName || 
		oldName === newName || 
		property.compositeClusteringKey || 
		property.compositePartitionKey) {
		return '';
	}
	const deletePropertyScript = getDelete(getData({ name: oldName }));
	const addPropertyScript = getAdd(getData({ name: newName }));
	return [...deletePropertyScript, ...addPropertyScript];
};

const getDeleteTable = deleteData => { 
	const tableStatement = getTableNameStatement(deleteData.keyspaceName, deleteData.tableName);
	const script = `DROP TABLE IF EXISTS ${tableStatement};`;
	return [{
		modified: false,
		added: false,
		deleted: true,
		script,
		table: 'table',
	}];
};

const getIsChangeTable = compMod => {
	const tableProperties = ['name', 'isActivated'];
	return tableProperties.some(property => !_.isEqual(compMod[property]?.new, compMod[property]?.old));
}

const getPropertiesForUpdateTable = properties => {
	const newProperties = Object.entries(properties).map(([name, value]) => {
		if (!value.compMod) {
			return [name, value];
		}
		const newField = value.compMod?.newField || {};
		const oldField = value.compMod?.oldField || {};
		Object.entries(newField).map(([keyNewField, valueNewField]) => {
			if (oldField[keyNewField] !== valueNewField) {
				value[keyNewField] = valueNewField;
			}
			if (keyNewField === 'name' && oldField[keyNewField] !== valueNewField) {
				name = valueNewField;
			}
		})
		return [name, value];
	})
	return Object.fromEntries(newProperties);
} 

const getUpdateTable = updateData => {
	const { item, propertiesScript = [] } = updateData;
	const { oldName, newName } = getCollectionName(item.role?.compMod);

	const indexTableScript = getIndexTable(item, updateData.data);

	const isChangeTable = getIsChangeTable({ ...item.role?.compMod, name: { new: newName, old: oldName } } || {});

	if (!isChangeTable) {
		const tableName = updateData.tableName || oldName || newName;
		const optionScript = getOptionsScript(item.role?.compMod || {}, tableName, updateData.isOptionScript);
		return [
			{
				added: false,
				deleted: false,
				modified: true,
				script: optionScript,
				table: 'table',
			},
			...indexTableScript,
			...propertiesScript
		];
	}
		
	if (!oldName || !newName) {
		return [];
	}

	const data = { 
		keyspaceName: updateData.keyspaceName,
		data: updateData.data,
		item: {
			...item,
			properties: getPropertiesForUpdateTable(item.role?.properties || item.properties),
		},
		isKeyspaceActivated: true,
	};
	const deleteScript = getDeleteTable({ ...data, tableName: oldName });
	const addScript = getAddTable({ ...data, tableName: newName});
	return [...deleteScript, ...addScript, ...indexTableScript];
}

const getOptionsScript = (compMod, tableName, isGetOptionScript) => {
	if (!isGetOptionScript || !compMod || !compMod.tableOptions) {
		return '';
	}
	
	const script = getChangeOption({
		options: compMod.tableOptions,
		comment: compMod.comments
	});

	return script ? `${alterTablePrefix(tableName, compMod.keyspaceName)}${tab(script)};` : '';
}

const handleChange = (child, udtMap, generator, data) => {
	let alterTableScript = [];

	if (objectContainsProp(child, 'items') && child.items.length) {
		const alterScript = child.items.reduce((result, current) => {
			return result.concat(handleItem(current, udtMap, generator, data));
		}, []);
		alterTableScript = alterTableScript.concat(alterScript);
	} else if (objectContainsProp(child, 'items')) {
		alterTableScript = alterTableScript.concat(handleItem(child.items, udtMap, generator, data));
	}

	return alterTableScript;
}

const handleItem = (item, udtMap, generator, data) => {
	let alterTableScript = [];

	if (!objectContainsProp(item, 'properties')) {
			return alterTableScript;
	}

	const isOldModel = checkIsOldModel(_.get(data, 'modelData'));
	const itemProperties = item.properties;

	alterTableScript = Object.keys(itemProperties)
		.reduce((alterTableScript, tableKey) => {
			const itemCompModData = itemProperties[tableKey].role.compMod;
			const codeName = _.get(itemProperties, `${tableKey}.role.code`, '');
			const tableName = codeName.length ? codeName : tableKey;

			if (!itemCompModData) {
				return alterTableScript;
			}

			const tableProperties = itemProperties[tableKey].properties || {};

			const keyspaceName = itemCompModData.keyspaceName;

			if (itemCompModData.deleted) {
				const deletedIndexScript = getIndexTable(itemProperties[tableKey], data);
				return [ 
					...alterTableScript, 
					...getDeleteTable({
						keyspaceName,
						tableName
					}),
					...deletedIndexScript,
				];
			}

			if (itemCompModData.created) {
				const addedIndexScript = getIndexTable(itemProperties[tableKey], data);
				return [ 
					...alterTableScript, 
					...getAddTable({
						item: itemProperties[tableKey], 
						keyspaceName, 
						data, 
						tableName,
					}),
					...addedIndexScript,
				];
			}

			if (itemCompModData.modified) {
				const updateTableScript = getUpdateTable({ keyspaceName, data, item: itemProperties[tableKey], isOptionScript: true, tableName });

				return [...alterTableScript, ...updateTableScript];
			}

			const propertiesScript = handleProperties({ 
				generator,
				tableProperties, 
				udtMap, 
				itemCompModData, 
				tableName, 
				isOldModel,
				data,
			});

			const updateTableScript = getUpdateTable({ 
				item: itemProperties[tableKey], 
				isOptionScript: generator.name === 'getUpdate',
				propertiesScript,
				keyspaceName,
				tableName,
				data,
			})

			return [...alterTableScript, ...updateTableScript];
		}, []);

	return alterTableScript;
}

const getAddTable = (addTableData) => {
	const table = addTableData.item;
	const data = addTableData.data;
	const tableProperties = table.properties || {};
	let partitionKeys = [];
	let clusteringKeys = [];
	if (tableProperties) {
		partitionKeys = Object.keys(tableProperties).map(key => {
			if (tableProperties[key].compositePartitionKey) {
				return { keyId: tableProperties[key].GUID };
			}
			return;
		}).filter(item => item);

		clusteringKeys = Object.keys(tableProperties).map(key => {
			if (tableProperties[key].compositeClusteringKey) {
				return { keyId: tableProperties[key].GUID };
			}
			return;
		}).filter(item => item);
}

	const entityData = [{
		collectionName: addTableData.tableName,
		compositePartitionKey: [...partitionKeys],
		compositeClusteringKey: [...clusteringKeys],
		tableOptions: table.role.tableOptions || '',
		comments: table.role.comments || '',
		isActivated: table.role.isActivated,
	}];

	const dataSources = [
		data.externalDefinitions,
		data.modelDefinitions,
		data.internalDefinitions,
		table
	];

	const script = getTableStatement({
		tableData: table,
		tableMetaData: entityData,
		keyspaceMetaData: [{ name: addTableData.keyspaceName }],
		dataSources,
		udtTypeMap: data.udtTypeMap || {},
		isKeyspaceActivated: addTableData.isKeyspaceActivated,
	});

	return [{
		deleted: false,
		modified: false,
		added: true,
		script,
		table: 'table',
	}];
}

const handleAlterTypeForOldModel = ({ property, udtMap, tableName, keyspaceName, columnName }) => {
	const { oldField, newField } = property?.compMod || {};
	if (!oldField && !newField) {
		return;
	}

	const oldFieldCassandraType = getTypeByData(oldField, udtMap);
	const newFieldCassandraType = getTypeByData(newField, udtMap);

	if (!oldFieldCassandraType || !newFieldCassandraType || oldFieldCassandraType === newFieldCassandraType) {
		return;
	}

	const isFieldFieldTypeCompatible = fieldTypeCompatible(oldFieldCassandraType, newFieldCassandraType);

	if (!isFieldFieldTypeCompatible) {
		return;
	}

	const innerScript = getUpdateType({
		keySpace: keyspaceName,
		tableName: tableName,
		columnData: {
			name: columnName,
			type: newFieldCassandraType
		}
	});

	return {
		script: innerScript,
		added: false,
		deleted: false,
		modified: true,
		keySpaces: keyspaceName,
		name: tableName,
		columnName: columnName
	};
}

const handleProperties = ({ generator, tableProperties, udtMap, itemCompModData, tableName, isOldModel, data }) => {
	return Object.keys(tableProperties)
		.reduce((alterTableScript, columnName) => {
			const property = tableProperties[columnName];
			if (generator.name !== 'getUpdate' && (property.compositePartitionKey || property.compositeClusteringKey)) {
				return alterTableScript;
			}
			let columnType = getTypeByData(property, udtMap, columnName);
			
			if (property.$ref && !columnType) {
				columnType = _.last(property.$ref.split('/'));
			}

			if (!columnType) {
				return alterTableScript;
			}

			const keyspaceName = itemCompModData?.keyspaceName;

			if (isOldModel) {
				alterTableScript = alterTableScript.concat(handleAlterTypeForOldModel({ property, udtMap, tableName, keyspaceName, columnName }) || []);
			}

			if (generator.name === 'getUpdate' && !property.compMod) {
				return alterTableScript;
			}

			return [
				...alterTableScript,
				...generator({
					keyspaceName,
					tableName,
					columnData: {
						name: columnName,
						type: columnType
					},
					property,
				})
			];
		}, []);
}

const columns = {
	views: getViewScript,
	containers: getKeySpaceScript,
	udt: getUdtScript,
}

const generateScript = (child, udtMap, data, column, mode) => {
	const getScript = columns[column];

	if (Array.isArray(child) && child.length) {
		return child.reduce((scriptsData, item) => 
			([...scriptsData, 
				...getScript({ child: item.properties[Object.keys(item.properties)[0]], udtMap, data, mode })]), 
			[]);
	}
	const properties = child.properties;
	const itemKey = Object.keys(properties)[0];
	const item = properties[itemKey];

	return getScript({ child: item, udtMap, data, mode });
}

const getScript = (child, udtMap, data, column, mode, options = {}) => {
	let alterScript = [];

	if (objectContainsProp(child, 'properties')) {
		alterScript = mergeArrays(alterScript, getScript(child.properties, udtMap, data, column, undefined, options));
	}

	if (objectContainsProp(child, 'modified') && !options[column]?.skipModified) {
		alterScript = mergeArrays(alterScript, getScript(child.modified, udtMap, data, column, 'update', options));
	}

	if (objectContainsProp(child, 'added')) {
		alterScript = mergeArrays(alterScript, getScript(child.added, udtMap, data, column, 'add', options));
	}

	if (objectContainsProp(child, 'deleted')) {
		alterScript = mergeArrays(alterScript, getScript(child.deleted, udtMap, data, column, 'delete', options));
	}

	if (objectContainsProp(child, 'items')) {
		alterScript = mergeArrays(alterScript, generateScript(child.items, udtMap, data, column, mode));
	}

	return alterScript;
};

const getAlterTableScript = (child, udtMap, data) => {
	let alterScript = [];

	if (objectContainsProp(child, 'properties')) {
		alterScript = mergeArrays(alterScript, getAlterTableScript(child.properties, udtMap, data));
	}

	if (objectContainsProp(child, 'items')) {
		alterScript = mergeArrays(alterScript, getAlterTableScript(child.items, udtMap, data));
	}

	if (objectContainsProp(child, 'entities')) {
		alterScript = mergeArrays(alterScript, getAlterTableScript(child.entities, udtMap, data));
	}

	if (objectContainsProp(child, 'views')) {
		alterScript = mergeArrays(alterScript, getScript(child.views, udtMap, data, 'views'));
	}

	if (objectContainsProp(child, 'containers')) {
		alterScript = mergeArrays(alterScript, getScript(child.containers, udtMap, data, 'containers', undefined, data.scriptOptions));
	}

	if (objectContainsProp(child, 'modelDefinitions')) {
		alterScript = mergeArrays(alterScript, getScript(sortAddedUdt(child.modelDefinitions), udtMap, data, 'udt'));
	}

	if (objectContainsProp(child, 'added')) {
		alterScript = mergeArrays(alterScript, handleChange(child.added, udtMap, getAdd, data));
	}

	if (objectContainsProp(child, 'modified')) {
		alterScript = mergeArrays(alterScript, handleChange(child.modified, udtMap, getUpdate, data));
	}

	if (objectContainsProp(child, 'deleted')) {
		alterScript = mergeArrays(alterScript, handleChange(child.deleted, udtMap, getDelete, data));
	}

	return alterScript;
}

const getAlterScript = (child, udtMap, data) => {
	setDependencies(dependencies);
	let scriptData = getAlterTableScript(child, udtMap, data);
	scriptData = _.uniqWith(scriptData, _.isEqual);
	scriptData = getCommentedDropScript(scriptData, data);
	scriptData = sortScript(scriptData);
	return scriptData.filter(Boolean).join('\n\n');
}

const getCommentedDropScript = (scriptsData, data) => {
	const applyDropStatements = getApplyDropStatement(data);
	if (applyDropStatements) {
		return scriptsData;
	}
	return scriptsData.map((scriptData = {}) => {
		if (!scriptData.deleted || !scriptData.script) {
			return scriptData;
		}
		return {
			...scriptData,
			script: commentDeactivatedStatement(scriptData.script, false),
		};
	})
}

const isDropInStatements = (child, udtMap, data) => {
	setDependencies(dependencies);
	const scriptsData = getAlterTableScript(child, udtMap, data);
	return scriptsData.some(scriptData => !!scriptData.script && scriptData.deleted);
}

const sortScript = (scriptData) => {
	const filterProp = (key, prop, script = {}) => script[key] && script[prop];
	const filter = (key, scriptData, keyProp) => {
		return scriptData.reduce((scripts, currentScript) => {
			if (filterProp(key, keyProp, currentScript)) {
				scripts.scripts.push(currentScript);
				return scripts;
			}

			scripts.filteredScripts.push(currentScript);

			return scripts;
		}, { scripts: [], filteredScripts: [] });
	};

	const orderForScripts = [
		['keySpaces', 'added'],
		['keySpaces', 'modified'],
		['view', 'deleted'],
		['index', 'deleted'],
		['renewal', 'deleted'],
		['table', 'deleted'],
		['udt', 'deleted'],
		['udt', 'added'],
		['udt', 'modified'],
		['table', 'added'],
		['table', 'modified'],
		['field', 'deleted'],
		['field', 'added'],
		['field', 'modified'],
		['index', 'added'],
		['index', 'modified'],
		['renewal', 'added'],
		['view', 'added'],
		['view', 'modified'],
		['udf', 'deleted'],
		['udf', 'added'],
		['keySpaces', 'deleted'],
	];
	const sortedScripts = orderForScripts.reduce((script, [key, prop]) => {
		const { scripts, filteredScripts } = filter(prop, script.filteredScripts, key);
		return {
			sorted: [...script.sorted, ...scripts],
			filteredScripts
		}
	}, {
		sorted: [],
		filteredScripts: scriptData
	});

	return [...sortedScripts.sorted, ...sortedScripts.filteredScripts].map(data => data.script);
}

module.exports = {
	getAlterScript,
	isDropInStatements
};
